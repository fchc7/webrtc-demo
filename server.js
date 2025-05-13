const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();

// 创建 HTTPS 服务器
const httpsServer = https.createServer({
    key: fs.readFileSync('certs/key.pem'),
    cert: fs.readFileSync('certs/cert.pem')
}, app);

// 创建 HTTP 服务器
const httpServer = http.createServer(app);

const io = require('socket.io')(httpsServer);

// 浏览器检测中间件 - 放在最前面
app.use((req, res, next) => {

    console.log('请求URL:', req.url);
    console.log('请求头:', req.headers);
    
    // 获取 User-Agent
    const userAgent = req.headers['user-agent'] ? req.headers['user-agent'].toLowerCase() : '';
    console.log('User-Agent:', userAgent);
    
    // 检测是否是微信浏览器
    const isWeixinBrowser = userAgent.includes('micromessenger');
    console.log('是否是微信浏览器:', isWeixinBrowser);
    
    // 检测是否是 HTTPS
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    console.log('是否是HTTPS:', isHttps);
    
    // 获取当前请求的协议和主机
    const protocol = isHttps ? 'https' : 'http';
    const host = req.headers.host.split(':')[0];
    console.log('主机名:', host);
    
    
    // 如果是微信浏览器且不是 HTTPS，重定向到 HTTP 的提示页
    if (isWeixinBrowser && !isHttps) {
        if (req.url === '/wechat-tip.html') {
            return next();
        }
        console.log('检测到微信浏览器，重定向到 HTTP 提示页');
        return res.redirect(`http://${host}:3000/wechat-tip.html`);
    }
    
    // 如果不是微信浏览器且不是 HTTPS，重定向到 HTTPS
    if (!isWeixinBrowser && !isHttps) {
        const httpsUrl = `https://${host}:3001`;
        console.log('非微信浏览器，重定向到 HTTPS:', httpsUrl);
        return res.redirect(httpsUrl);
    }
    
    console.log('通过中间件检查，继续处理请求');
    next();
});

// 提供静态文件 - 放在中间件之后
app.use(express.static('public'));

// 设置路由 - 放在最后
app.get('/', (req, res) => {
    console.log('处理根路径请求');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO 信令逻辑
io.on('connection', (socket) => {
    console.log('新用户连接:', socket.id);
    
    socket.on('join', (room) => {
        socket.join(room);
        const clients = io.sockets.adapter.rooms.get(room);
        const numClients = clients ? clients.size : 0;
        console.log(`用户 ${socket.id} 加入房间 ${room}，当前房间人数: ${numClients}`);
        socket.emit('joined', { room, id: socket.id, numClients });
        socket.to(room).emit('peer-joined', { id: socket.id, numClients });
    });

    socket.on('signal', ({ room, data }) => {
        // 转发信令消息到同一房间的其他用户
        socket.to(room).emit('signal', { id: socket.id, data });
    });

    socket.on('disconnecting', () => {
        for (const room of socket.rooms) {
            if (room !== socket.id) {
                socket.to(room).emit('peer-left', { id: socket.id });
            }
        }
    });

    socket.on('chat-message', (data) => {
        console.log('收到聊天消息:', { sender: socket.id, room: data.room, message: data.message });
        socket.to(data.room).emit('chat-message', { sender: socket.id, message: data.message });
    });
});

// 启动服务器
const HTTP_PORT = 3000;
const HTTPS_PORT = 3001;

// 启动 HTTP 服务器
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`HTTP 服务器运行在 http://localhost:${HTTP_PORT}`);
    const interfaces = os.networkInterfaces();
    console.log('请使用以下任一局域网IP地址访问:');
    Object.keys(interfaces).forEach((ifname) => {
        interfaces[ifname].forEach((iface) => {
            if (iface.family === 'IPv4' && !iface.internal) {
                console.log(`http://${iface.address}:${HTTP_PORT}`);
            }
        });
    });
});

// 启动 HTTPS 服务器
httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`HTTPS 服务器运行在 https://localhost:${HTTPS_PORT}`);
    const interfaces = os.networkInterfaces();
    console.log('请使用以下任一局域网IP地址访问:');
    Object.keys(interfaces).forEach((ifname) => {
        interfaces[ifname].forEach((iface) => {
            if (iface.family === 'IPv4' && !iface.internal) {
                console.log(`https://${iface.address}:${HTTPS_PORT}`);
            }
        });
    });
}); 