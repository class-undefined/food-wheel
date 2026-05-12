from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import platform
import random
import re
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Set

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator


BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

DEFAULT_OPTIONS = ["火锅", "烧烤", "麻辣烫", "拉面", "寿司", "汉堡", "粤菜", "轻食"]
MAX_OPTIONS = 24
MAX_HISTORY = 30


StrategyName = Literal["single", "best_of_3", "best_of_5", "first_to"]


class ClientIdentity(BaseModel):
    client_id: Optional[str] = None
    nickname: Optional[str] = None
    fingerprint: Optional[str] = None
    timezone: Optional[str] = None
    screen: Optional[str] = None


class SettingsUpdate(BaseModel):
    options: List[str] = Field(default_factory=list)
    strategy: StrategyName = "single"
    target_wins: int = Field(default=1, ge=1, le=5)

    @field_validator("options")
    @classmethod
    def normalize_options(cls, value: List[str]) -> List[str]:
        cleaned: List[str] = []
        seen: Set[str] = set()
        for item in value:
            text = re.sub(r"\s+", " ", str(item)).strip()
            if not text or text in seen:
                continue
            cleaned.append(text[:24])
            seen.add(text)
        if len(cleaned) < 2:
            raise ValueError("至少需要两个可选项")
        return cleaned[:MAX_OPTIONS]


class RenameRequest(BaseModel):
    nickname: str = Field(min_length=1, max_length=18)

    @field_validator("nickname")
    @classmethod
    def normalize_nickname(cls, value: str) -> str:
        text = re.sub(r"\s+", " ", value).strip()
        if not text:
            raise ValueError("昵称不能为空")
        return text


@dataclass
class Visitor:
    client_id: str
    nickname: str
    fingerprint: Optional[str]
    ip: str
    mac: Optional[str]
    user_agent: str
    timezone: Optional[str]
    screen: Optional[str]
    first_seen: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    online: bool = False


@dataclass
class RoomState:
    room_id: str
    options: List[str] = field(default_factory=lambda: DEFAULT_OPTIONS.copy())
    strategy: StrategyName = "single"
    target_wins: int = 1
    round_no: int = 0
    current_result: Optional[str] = None
    final_result: Optional[str] = None
    scores: Dict[str, int] = field(default_factory=dict)
    history: List[Dict[str, Any]] = field(default_factory=list)
    visitors: Dict[str, Visitor] = field(default_factory=dict)
    connections: Set[WebSocket] = field(default_factory=set)
    connection_clients: Dict[int, Optional[str]] = field(default_factory=dict)

    def effective_target_wins(self) -> int:
        if self.strategy == "single":
            return 1
        if self.strategy == "best_of_3":
            return 2
        if self.strategy == "best_of_5":
            return 3
        return self.target_wins

    def strategy_label(self) -> str:
        labels = {
            "single": "一次定结果",
            "best_of_3": "三局两胜",
            "best_of_5": "五局三胜",
            "first_to": f"先赢 {self.target_wins} 次",
        }
        return labels[self.strategy]


rooms: Dict[str, RoomState] = {}
state_lock = asyncio.Lock()

app = FastAPI(title="今天吃什么转盘")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def room_or_create(room_id: str) -> RoomState:
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "-", room_id.strip())[:40] or "default"
    if safe_id not in rooms:
        rooms[safe_id] = RoomState(room_id=safe_id)
    return rooms[safe_id]


def get_request_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    return request.client.host if request.client else "unknown"


def get_ws_ip(websocket: WebSocket) -> str:
    forwarded = websocket.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    real_ip = websocket.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    return websocket.client.host if websocket.client else "unknown"


def is_private_network_ip(ip: str) -> bool:
    try:
        parsed = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return parsed.is_private or parsed.is_loopback or parsed.is_link_local


def lookup_mac_address(ip: str) -> Optional[str]:
    if not is_private_network_ip(ip):
        return None

    commands = []
    system = platform.system().lower()
    if system == "darwin":
        commands = [["arp", "-n", ip], ["arp", "-a", ip]]
    elif system == "linux":
        commands = [["ip", "neigh", "show", ip], ["arp", "-n", ip]]
    else:
        commands = [["arp", "-a", ip]]

    mac_pattern = re.compile(r"(?i)(?:[0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}")
    for command in commands:
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=0.4,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        match = mac_pattern.search(result.stdout + result.stderr)
        if match:
            return ":".join(part.zfill(2) for part in match.group(0).replace("-", ":").split(":")).lower()
    return None


def fallback_fingerprint(ip: str, user_agent: str, fingerprint: Optional[str]) -> str:
    raw = "|".join([ip, user_agent, fingerprint or ""])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def visitor_payload(visitor: Visitor) -> Dict[str, Any]:
    return {
        "client_id": visitor.client_id,
        "nickname": visitor.nickname,
        "fingerprint": visitor.fingerprint,
        "ip": visitor.ip,
        "mac": visitor.mac,
        "user_agent": visitor.user_agent,
        "timezone": visitor.timezone,
        "screen": visitor.screen,
        "online": visitor.online,
        "first_seen": visitor.first_seen,
        "last_seen": visitor.last_seen,
    }


def room_payload(room: RoomState) -> Dict[str, Any]:
    return {
        "room_id": room.room_id,
        "options": room.options,
        "strategy": room.strategy,
        "strategy_label": room.strategy_label(),
        "target_wins": room.target_wins,
        "effective_target_wins": room.effective_target_wins(),
        "round_no": room.round_no,
        "current_result": room.current_result,
        "final_result": room.final_result,
        "scores": room.scores,
        "history": room.history,
        "visitors": [visitor_payload(v) for v in sorted(room.visitors.values(), key=lambda item: item.last_seen, reverse=True)],
        "online_count": sum(1 for v in room.visitors.values() if v.online),
        "mac_note": "浏览器请求不会携带 MAC；仅同局域网且服务端 ARP/邻居表可见时可能推断。",
        "server_time": time.time(),
    }


async def broadcast(room: RoomState) -> None:
    if not room.connections:
        return
    payload = {"type": "state", "state": room_payload(room)}
    disconnected: List[WebSocket] = []
    for connection in list(room.connections):
        try:
            await connection.send_json(payload)
        except RuntimeError:
            disconnected.append(connection)
    for connection in disconnected:
        room.connections.discard(connection)


async def identify_visitor(room: RoomState, request: Request, data: ClientIdentity) -> Visitor:
    ip = get_request_ip(request)
    user_agent = request.headers.get("user-agent", "unknown")
    client_id = data.client_id or f"c_{uuid.uuid4().hex[:16]}"
    nickname = (data.nickname or "").strip()
    mac = lookup_mac_address(ip)
    existing = room.visitors.get(client_id)

    if existing:
        existing.ip = ip
        existing.user_agent = user_agent
        existing.fingerprint = data.fingerprint or existing.fingerprint
        existing.timezone = data.timezone or existing.timezone
        existing.screen = data.screen or existing.screen
        existing.mac = mac or existing.mac
        existing.last_seen = time.time()
        if nickname:
            existing.nickname = nickname[:18]
        return existing

    sequence = len(room.visitors) + 1
    visitor = Visitor(
        client_id=client_id,
        nickname=nickname[:18] if nickname else f"访客 {sequence}",
        fingerprint=data.fingerprint or fallback_fingerprint(ip, user_agent, data.fingerprint),
        ip=ip,
        mac=mac,
        user_agent=user_agent,
        timezone=data.timezone,
        screen=data.screen,
    )
    room.visitors[client_id] = visitor
    return visitor


def choose_result(room: RoomState) -> str:
    return random.SystemRandom().choice(room.options)


def apply_spin(room: RoomState, visitor: Optional[Visitor]) -> Dict[str, Any]:
    if room.final_result:
        raise HTTPException(status_code=409, detail="当前策略已经决出最终结果，请重置后再转。")

    result = choose_result(room)
    room.round_no += 1
    room.current_result = result
    room.scores[result] = room.scores.get(result, 0) + 1
    target = room.effective_target_wins()
    if room.scores[result] >= target:
        room.final_result = result

    record = {
        "round": room.round_no,
        "result": result,
        "final": room.final_result == result,
        "spinner": visitor.nickname if visitor else "匿名用户",
        "client_id": visitor.client_id if visitor else None,
        "created_at": time.time(),
    }
    room.history.insert(0, record)
    room.history = room.history[:MAX_HISTORY]
    return record


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/state/{room_id}")
async def get_state(room_id: str) -> Dict[str, Any]:
    async with state_lock:
        return room_payload(room_or_create(room_id))


@app.post("/api/identify")
async def identify(request: Request, data: ClientIdentity) -> Dict[str, Any]:
    room_id = request.query_params.get("room", "default")
    async with state_lock:
        room = room_or_create(room_id)
        visitor = await identify_visitor(room, request, data)
        await broadcast(room)
        return {"visitor": visitor_payload(visitor), "state": room_payload(room)}


@app.post("/api/rooms/{room_id}/nickname")
async def rename(room_id: str, request: Request, data: RenameRequest) -> Dict[str, Any]:
    client_id = request.headers.get("x-client-id")
    if not client_id:
        raise HTTPException(status_code=400, detail="缺少客户端 ID")
    async with state_lock:
        room = room_or_create(room_id)
        visitor = room.visitors.get(client_id)
        if not visitor:
            raise HTTPException(status_code=404, detail="未找到当前访客")
        visitor.nickname = data.nickname
        visitor.last_seen = time.time()
        await broadcast(room)
        return {"visitor": visitor_payload(visitor), "state": room_payload(room)}


@app.post("/api/rooms/{room_id}/settings")
async def update_settings(room_id: str, data: SettingsUpdate) -> Dict[str, Any]:
    async with state_lock:
        room = room_or_create(room_id)
        room.options = data.options
        room.strategy = data.strategy
        room.target_wins = data.target_wins
        room.round_no = 0
        room.current_result = None
        room.final_result = None
        room.scores = {}
        room.history = []
        await broadcast(room)
        return room_payload(room)


@app.post("/api/rooms/{room_id}/spin")
async def spin(room_id: str, request: Request) -> Dict[str, Any]:
    client_id = request.headers.get("x-client-id")
    async with state_lock:
        room = room_or_create(room_id)
        visitor = room.visitors.get(client_id) if client_id else None
        if visitor:
            visitor.last_seen = time.time()
        record = apply_spin(room, visitor)
        await broadcast(room)
        return {"record": record, "state": room_payload(room)}


@app.post("/api/rooms/{room_id}/reset")
async def reset(room_id: str) -> Dict[str, Any]:
    async with state_lock:
        room = room_or_create(room_id)
        room.round_no = 0
        room.current_result = None
        room.final_result = None
        room.scores = {}
        room.history = []
        await broadcast(room)
        return room_payload(room)


@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str) -> None:
    await websocket.accept()
    client_id = websocket.query_params.get("client_id")
    async with state_lock:
        room = room_or_create(room_id)
        room.connections.add(websocket)
        room.connection_clients[id(websocket)] = client_id
        if client_id and client_id in room.visitors:
            visitor = room.visitors[client_id]
            visitor.online = True
            visitor.last_seen = time.time()
            visitor.ip = get_ws_ip(websocket)
        await websocket.send_json({"type": "state", "state": room_payload(room)})
        await broadcast(room)

    try:
        while True:
            message = await websocket.receive_json()
            if message.get("type") == "ping":
                async with state_lock:
                    room = room_or_create(room_id)
                    if client_id and client_id in room.visitors:
                        room.visitors[client_id].last_seen = time.time()
                    await websocket.send_json({"type": "pong", "server_time": time.time()})
    except WebSocketDisconnect:
        async with state_lock:
            room = room_or_create(room_id)
            room.connections.discard(websocket)
            room.connection_clients.pop(id(websocket), None)
            if client_id and client_id in room.visitors:
                room.visitors[client_id].online = client_id in room.connection_clients.values()
                room.visitors[client_id].last_seen = time.time()
            await broadcast(room)
