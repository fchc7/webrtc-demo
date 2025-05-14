const express = require("express");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const viewerApp = express(); // 新增拉流应用

// 创建 HTTPS 服务器（会议端）
const httpsServer = https.createServer(
  {
    key: fs.readFileSync("certs/key.pem"),
    cert: fs.readFileSync("certs/cert.pem"),
  },
  app
);

// 创建 HTTP 服务器（会议端）
const httpServer = http.createServer(app);

// 创建 HTTP 服务器（拉流端）
const viewerServer = http.createServer(viewerApp);

// 为所有服务器创建Socket.IO实例
const io = require("socket.io")(httpsServer);
const viewerIo = require("socket.io")(viewerServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// 文件存储对象，用于临时存储通过聊天发送的文件
const fileStorage = {};
// 分块文件临时存储
const chunkStorage = {};

// 浏览器检测中间件 - 放在最前面
app.use((req, res, next) => {
  console.log("会议端请求URL:", req.url);
  console.log("会议端请求头:", req.headers);

  // 获取 User-Agent
  const userAgent = req.headers["user-agent"]
    ? req.headers["user-agent"].toLowerCase()
    : "";
  console.log("User-Agent:", userAgent);

  // 检测是否是微信浏览器
  const isWeixinBrowser = userAgent.includes("micromessenger");
  console.log("是否是微信浏览器:", isWeixinBrowser);

  // 检测是否是 HTTPS
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  console.log("是否是HTTPS:", isHttps);

  // 获取当前请求的协议和主机
  const protocol = isHttps ? "https" : "http";
  const host = req.headers.host.split(":")[0];
  console.log("主机名:", host);

  // 如果是微信浏览器且不是 HTTPS，重定向到 HTTP 的提示页
  if (isWeixinBrowser && !isHttps) {
    if (req.url === "/wechat-tip.html") {
      return next();
    }
    console.log("检测到微信浏览器，重定向到 HTTP 提示页");
    return res.redirect(`http://${host}:3000/wechat-tip.html`);
  }

  // 如果不是微信浏览器且不是 HTTPS，重定向到 HTTPS
  if (!isWeixinBrowser && !isHttps) {
    const httpsUrl = `https://${host}:3001`;
    console.log("非微信浏览器，重定向到 HTTPS:", httpsUrl);
    return res.redirect(httpsUrl);
  }

  console.log("通过中间件检查，继续处理请求");
  next();
});

// ==== 会议端配置 ====
// 为会议端提供静态文件
app.use(express.static("public"));

// 设置会议端路由
app.get("/", (req, res) => {
  console.log("处理会议端根路径请求");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ==== 拉流端配置 =====
// 1. 请求日志中间件
viewerApp.use((req, res, next) => {
  console.log("拉流端请求:", req.method, req.url);
  next();
});

// 2. 对根路径和index.html的请求都返回viewer.html
viewerApp.get(["/", "/index.html"], (req, res) => {
  console.log("拉流端根路径或index.html请求 - 返回viewer.html");
  res.sendFile(path.join(__dirname, "public", "viewer.html"));
});

// 3. 其他所有路径使用静态文件中间件
viewerApp.use(express.static("public"));

// 4. 最后的后备处理 - 所有其他未匹配的路由也返回viewer.html
viewerApp.use((req, res) => {
  console.log("拉流端未匹配路由:", req.url, "- 返回viewer.html");
  res.sendFile(path.join(__dirname, "public", "viewer.html"));
});

// 同步会议端和拉流端的房间和用户信息
const rooms = {};

// 辅助函数：广播房间信息给所有连接
function broadcastRoomInfo(roomId) {
  const room = rooms[roomId] || { users: [] };
  const roomInfo = {
    room: roomId,
    users: room.users.map((u) => ({ id: u.id, type: u.type })),
    numClients: room.users.length,
  };

  // 向会议端和拉流端广播房间信息
  io.to(roomId).emit("room-info", roomInfo);
  viewerIo.to(roomId).emit("room-info", roomInfo);
}

// 辅助函数：查找房间中的会议端用户
function findMeetingSocketIdForRoom(roomId) {
  if (!rooms[roomId]) return null;

  const meetingUser = rooms[roomId].users.find(
    (user) => user.type === "meeting"
  );
  return meetingUser ? meetingUser.id : null;
}

// 会议端 Socket.IO 信令逻辑
io.on("connection", (socket) => {
  console.log("会议端新用户连接:", socket.id);
  socket.data.type = "meeting"; // 标记为会议端用户

  socket.on("join", (room) => {
    socket.join(room);

    // 初始化房间数据
    if (!rooms[room]) {
      rooms[room] = { users: [] };
    }

    // 添加用户到房间
    rooms[room].users.push({ id: socket.id, type: "meeting" });

    const numClients = rooms[room].users.length;
    console.log(
      `会议端用户 ${socket.id} 加入房间 ${room}，当前房间人数: ${numClients}`
    );

    // 存储房间信息到socket对象
    socket.data.room = room;

    // 向用户发送已加入信息和当前房间信息
    socket.emit("joined", { room, id: socket.id, numClients });

    // 向房间内其他用户广播新用户加入信息
    socket
      .to(room)
      .emit("peer-joined", { id: socket.id, type: "meeting", numClients });

    // 广播房间信息
    broadcastRoomInfo(room);
  });

  socket.on("signal", ({ room, data }) => {
    // 转发信令消息到同一房间的其他用户 (other meeting clients)
    socket.to(room).emit("signal", { id: socket.id, data });

    // 同时转发到拉流端 (viewer clients)
    viewerIo.to(room).emit("signal", { id: socket.id, data });
  });

  socket.on("disconnecting", () => {
    const room = socket.data.room;

    if (room && rooms[room]) {
      // 从房间用户列表中移除该用户
      rooms[room].users = rooms[room].users.filter(
        (user) => user.id !== socket.id
      );

      // 如果房间为空，清理房间数据
      if (rooms[room].users.length === 0) {
        delete rooms[room];
      } else {
        // 否则广播用户离开
        socket.to(room).emit("peer-left", { id: socket.id });

        // 广播更新后的房间信息
        broadcastRoomInfo(room);
      }
    }
  });

  socket.on("chat-message", (data) => {
    console.log("会议端收到聊天消息:", {
      sender: socket.id,
      room: data.room,
      message: data.message,
    });
    // 转发到同一房间的所有用户
    socket
      .to(data.room)
      .emit("chat-message", { sender: socket.id, message: data.message });
    // 同时转发到拉流端
    viewerIo
      .to(data.room)
      .emit("chat-message", { sender: `会议端用户`, message: data.message });
  });

  socket.on("file-data", (data) => {
    console.log(
      "会议端收到文件数据:",
      data.name,
      "大小:",
      data.data ? data.data.byteLength : "未知"
    );

    // 存储文件到临时存储
    const fileId = Date.now() + "-" + data.name;
    fileStorage[fileId] = {
      data: data.data,
      name: data.name,
      timestamp: Date.now(),
      room: data.room,
    };

    // 转发到同一房间的所有会议端用户
    socket.to(data.room).emit("file-data", {
      name: data.name,
      data: data.data,
      sender: socket.id,
    });

    // 转发到同一房间的所有拉流端用户
    viewerIo.to(data.room).emit("file-data", {
      name: data.name,
      data: data.data,
      sender: "会议端用户",
    });

    // 设置定时器，一小时后清理文件数据
    setTimeout(() => {
      delete fileStorage[fileId];
      console.log(`文件 ${fileId} 已从临时存储中删除`);
    }, 3600000); // 1小时 = 3600000毫秒
  });

  // 处理ICE重启需求
  socket.on("ice-restart-needed", (data) => {
    console.log(
      `会议端 ${socket.id} 收到ICE重启请求，来自: ${data.viewerId}, 房间: ${data.room}`
    );

    // 这里只发送通知，实际的重启会由前端处理
    socket.emit("ice-restart-needed", data);
  });
});

// 拉流端 Socket.IO 信令逻辑
viewerIo.on("connection", (socket) => {
  console.log("拉流端新用户连接:", socket.id);
  socket.data.type = "viewer"; // 标记为拉流端用户

  socket.on("join", (room) => {
    socket.join(room);

    // 初始化房间数据
    if (!rooms[room]) {
      rooms[room] = { users: [] };
    }

    // 添加用户到房间
    rooms[room].users.push({ id: socket.id, type: "viewer" });

    const numClients = rooms[room].users.length;
    console.log(
      `拉流端用户 ${socket.id} 加入房间 ${room}，当前房间人数: ${numClients}`
    );

    // 存储房间信息到socket对象
    socket.data.room = room;

    // 向用户发送已加入信息和当前房间信息
    socket.emit("joined", { room, id: socket.id, numClients, type: "viewer" });

    // 向房间内其他用户广播新用户加入信息
    socket
      .to(room)
      .emit("peer-joined", { id: socket.id, type: "viewer", numClients });
    io.to(room).emit("peer-joined", {
      id: socket.id,
      type: "viewer",
      numClients,
    });

    // 广播房间信息
    broadcastRoomInfo(room);
  });

  socket.on("signal", ({ room, data }) => {
    // 转发信令消息到同一房间的其他用户
    socket.to(room).emit("signal", { id: socket.id, data });
    // 同时转发到会议端
    io.to(room).emit("signal", { id: socket.id, data });
  });

  socket.on("disconnecting", () => {
    const room = socket.data.room;

    if (room && rooms[room]) {
      // 从房间用户列表中移除该用户
      rooms[room].users = rooms[room].users.filter(
        (user) => user.id !== socket.id
      );

      // 如果房间为空，清理房间数据
      if (rooms[room].users.length === 0) {
        delete rooms[room];
      } else {
        // 否则广播用户离开
        socket.to(room).emit("peer-left", { id: socket.id });
        io.to(room).emit("peer-left", { id: socket.id });

        // 广播更新后的房间信息
        broadcastRoomInfo(room);
      }
    }
  });

  socket.on("chat-message", (data) => {
    console.log("拉流端收到聊天消息:", {
      sender: socket.id,
      room: data.room,
      message: data.message,
    });

    // 转发到同一房间的所有拉流端用户
    socket
      .to(data.room)
      .emit("chat-message", { sender: "观看端用户", message: data.message });

    // 转发到同一房间的所有会议端用户
    io.to(data.room).emit("chat-message", {
      sender: "观看端用户",
      message: data.message,
    });
  });

  // 处理常规文件传输 (非iOS设备)
  socket.on("file-data", (data) => {
    console.log(
      "拉流端收到文件数据:",
      data.name,
      "大小:",
      data.data ? data.data.byteLength : "未知"
    );

    // 存储文件到临时存储
    const fileId = Date.now() + "-" + data.name;
    fileStorage[fileId] = {
      data: data.data,
      name: data.name,
      timestamp: Date.now(),
      room: data.room,
    };

    // 转发到同一房间的所有拉流端用户
    socket.to(data.room).emit("file-data", {
      name: data.name,
      data: data.data,
      sender: "观看端用户",
    });

    // 转发到同一房间的所有会议端用户
    io.to(data.room).emit("file-data", {
      name: data.name,
      data: data.data,
      sender: "观看端用户",
    });

    // 设置定时器，一小时后清理文件数据
    setTimeout(() => {
      delete fileStorage[fileId];
      console.log(`文件 ${fileId} 已从临时存储中删除`);
    }, 3600000); // 1小时 = 3600000毫秒
  });

  // 处理文件元数据 (iOS设备分块传输)
  socket.on("file-metadata", (data) => {
    console.log(
      `拉流端收到文件元数据: ${data.name}, 大小: ${data.size}, 分块数: ${data.totalChunks}`
    );

    // 创建分块存储对象
    const fileId = Date.now() + "-" + data.name;
    chunkStorage[fileId] = {
      name: data.name,
      size: data.size,
      totalChunks: data.totalChunks,
      receivedChunks: 0,
      chunks: new Array(data.totalChunks),
      room: data.room,
      timestamp: Date.now(),
      sender: socket.id,
    };
  });

  socket.on("file-chunk", (data) => {
    const { name, chunk, index, total, room } = data;

    // 查找正确的文件存储
    const fileId = Object.keys(chunkStorage).find(
      (id) =>
        chunkStorage[id].name === name &&
        chunkStorage[id].totalChunks === total &&
        chunkStorage[id].room === room
    );

    if (!fileId) {
      console.log(`找不到文件 ${name} 的分块存储`);
      return;
    }

    // 存储分块
    const fileInfo = chunkStorage[fileId];
    fileInfo.chunks[index] = chunk;
    fileInfo.receivedChunks++;

    console.log(`接收到文件 ${name} 的分块 ${index + 1}/${total}`);

    // 检查是否所有分块都已接收
    if (fileInfo.receivedChunks === fileInfo.totalChunks) {
      console.log(`所有分块已接收完成，正在重构文件 ${name}`);

      try {
        // 合并所有分块
        let totalLength = 0;
        fileInfo.chunks.forEach((chunk) => {
          totalLength += chunk.byteLength;
        });

        const completeFile = new Uint8Array(totalLength);
        let offset = 0;

        fileInfo.chunks.forEach((chunk) => {
          completeFile.set(new Uint8Array(chunk), offset);
          offset += chunk.byteLength;
        });

        // 文件重构完成，现在处理和保存
        const buffer = completeFile.buffer;

        // 存储到临时文件存储
        fileStorage[fileId] = {
          data: buffer,
          name: fileInfo.name,
          timestamp: Date.now(),
          room: fileInfo.room,
        };

        // 转发到其他拉流端用户
        socket.to(room).emit("file-data", {
          name: fileInfo.name,
          data: buffer,
          sender: "观看端用户",
        });

        // 转发到会议端用户
        io.to(room).emit("file-data", {
          name: fileInfo.name,
          data: buffer,
          sender: "观看端用户",
        });

        // 清理分块存储
        delete chunkStorage[fileId];

        // 设置定时器清理完整文件
        setTimeout(() => {
          delete fileStorage[fileId];
          console.log(`文件 ${fileId} 已从临时存储中删除`);
        }, 3600000); // 1小时

        console.log(`文件 ${name} 处理完成并已转发`);
      } catch (error) {
        console.error(`处理文件 ${name} 时出错:`, error);
        delete chunkStorage[fileId]; // 出错时清理
      }
    }
  });

  // 处理ICE重启请求
  socket.on("ice-restart-request", ({ room }) => {
    console.log(`[${socket.id}] requested ICE restart for room ${room}`);
    // 将重启ICE请求转发给该房间的会议端
    const meetingSocketId = findMeetingSocketIdForRoom(room);
    if (meetingSocketId) {
      io.to(meetingSocketId).emit("ice-restart-needed", { room });
      console.log(
        `[${socket.id}] ice-restart-request forwarded to meeting: ${meetingSocketId}`
      );
    } else {
      console.log(`[${socket.id}] No meeting found to forward ice-restart`);
    }
  });

  // 处理视频流请求消息
  socket.on("request-stream", ({ room }) => {
    console.log(`[${socket.id}] requested stream for room ${room}`);
    // 将视频流请求转发给该房间的会议端
    const meetingSocketId = findMeetingSocketIdForRoom(room);
    if (meetingSocketId) {
      io.to(meetingSocketId).emit("stream-requested", {
        room,
        viewerId: socket.id,
      });
      console.log(
        `[${socket.id}] request-stream forwarded to meeting: ${meetingSocketId}`
      );
    } else {
      console.log(`[${socket.id}] No meeting found to forward stream request`);
      // 通知viewer没有找到会议端
      socket.emit("stream-error", {
        room,
        error: "没有找到会议端",
      });
    }
  });
});

// 启动服务器
const HTTP_PORT = 3000;
const HTTPS_PORT = 3001;
const VIEWER_PORT = 3002; // 拉流端口

// 启动 HTTP 服务器（会议端）
httpServer.listen(HTTP_PORT, "0.0.0.0", () => {
  console.log(`HTTP 会议服务器运行在 http://localhost:${HTTP_PORT}`);
  const interfaces = os.networkInterfaces();
  console.log("请使用以下任一局域网IP地址访问会议端:");
  Object.keys(interfaces).forEach((ifname) => {
    interfaces[ifname].forEach((iface) => {
      if (iface.family === "IPv4" && !iface.internal) {
        console.log(`http://${iface.address}:${HTTP_PORT}`);
      }
    });
  });
});

// 启动 HTTPS 服务器（会议端）
httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
  console.log(`HTTPS 会议服务器运行在 https://localhost:${HTTPS_PORT}`);
  const interfaces = os.networkInterfaces();
  console.log("请使用以下任一局域网IP地址访问会议端:");
  Object.keys(interfaces).forEach((ifname) => {
    interfaces[ifname].forEach((iface) => {
      if (iface.family === "IPv4" && !iface.internal) {
        console.log(`https://${iface.address}:${HTTPS_PORT}`);
      }
    });
  });
});

// 启动 HTTP 服务器（拉流端）
viewerServer.listen(VIEWER_PORT, "0.0.0.0", () => {
  console.log(`HTTP 拉流服务器运行在 http://localhost:${VIEWER_PORT}`);
  const interfaces = os.networkInterfaces();
  console.log("请使用以下任一局域网IP地址访问拉流端:");
  Object.keys(interfaces).forEach((ifname) => {
    interfaces[ifname].forEach((iface) => {
      if (iface.family === "IPv4" && !iface.internal) {
        console.log(`http://${iface.address}:${VIEWER_PORT}`);
      }
    });
  });
  console.log(
    "注意: 3002端口将始终加载拉流页面(viewer.html)，不会加载index.html"
  );
});
