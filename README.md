# 今天吃什么转盘

一个基于 FastAPI 的联机转盘小项目，用来决定吃什么。前端适配移动设备，后端提供房间状态、转盘记录、设备识别和 WebSocket 实时同步。

## 启动

```bash
python3 -m pip install -r requirements.txt
python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

打开：

```text
http://localhost:8000
```

同一局域网内其他设备访问时，把 `localhost` 换成运行机器的局域网 IP。

## Docker

构建并运行：

```bash
docker build -t food-wheel .
docker run --rm -p 8000:8000 food-wheel
```

容器内服务监听 `0.0.0.0:8000`，宿主机通过 `http://localhost:8000` 访问。

## 功能

- 默认房间 `default`，也可以在地址中使用 `?room=xxx` 创建不同房间。
- 支持一次定结果、三局两胜、五局三胜、自定义先胜局数。
- 多设备实时查看当前结果、比分、历史记录、在线用户。
- 支持设置昵称；未设置时后端自动分配访客昵称。
- 后端记录 IP、User-Agent、设备指纹、访问时间。
- MAC 地址只能尽力推断：HTTP/浏览器不会提供客户端 MAC。只有当客户端和服务端在同一二层局域网，且服务端系统 ARP/邻居表可见时，才可能取到。

## API

- `GET /api/state/{room_id}` 获取房间状态。
- `POST /api/identify` 识别或创建访客。
- `POST /api/rooms/{room_id}/settings` 更新选项和策略。
- `POST /api/rooms/{room_id}/spin` 转一次。
- `POST /api/rooms/{room_id}/reset` 重置当前对局。
- `WebSocket /ws/{room_id}?client_id=...` 实时同步房间状态。
