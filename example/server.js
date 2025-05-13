const express = require('express');
const path = require('path');
const os = require('os');

const app = express();

// 提供静态文件
app.use(express.static('public'));

// 设置路由
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 启动服务器
const PORT = 3001;
app.listen(PORT, '0.0.0.0', () => {
    const interfaces = os.networkInterfaces();
    console.log(`服务器运行在 http://localhost:${PORT}`);
    console.log('请使用以下任一局域网IP地址访问:');
    Object.keys(interfaces).forEach((ifname) => {
        interfaces[ifname].forEach((iface) => {
            if (iface.family === 'IPv4' && !iface.internal) {
                console.log(`http://${iface.address}:${PORT}`);
            }
        });
    });
}); 