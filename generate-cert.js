const forge = require('node-forge');
const fs = require('fs');
const path = require('path');

try {
    // 创建证书目录
    const certsDir = path.join(__dirname, 'certs');
    console.log('证书目录:', certsDir);
    
    if (!fs.existsSync(certsDir)) {
        console.log('创建证书目录...');
        fs.mkdirSync(certsDir);
    }

    // 生成密钥对
    console.log('生成密钥对...');
    const keys = forge.pki.rsa.generateKeyPair(2048);

    // 创建证书
    console.log('创建证书...');
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

    const attrs = [{
        name: 'commonName',
        value: 'localhost'
    }, {
        name: 'countryName',
        value: 'CN'
    }, {
        shortName: 'ST',
        value: 'State'
    }, {
        name: 'localityName',
        value: 'City'
    }, {
        name: 'organizationName',
        value: 'Test'
    }, {
        shortName: 'OU',
        value: 'Test'
    }];

    cert.setSubject(attrs);
    cert.setIssuer(attrs);

    // 设置证书扩展
    cert.setExtensions([{
        name: 'basicConstraints',
        cA: true
    }, {
        name: 'keyUsage',
        keyCertSign: true,
        digitalSignature: true,
        nonRepudiation: true,
        keyEncipherment: true,
        dataEncipherment: true
    }, {
        name: 'subjectAltName',
        altNames: [{
            type: 2,
            value: 'localhost'
        }]
    }]);

    // 签名证书
    console.log('签名证书...');
    cert.sign(keys.privateKey);

    // 转换为PEM格式
    console.log('转换为PEM格式...');
    const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
    const certPem = forge.pki.certificateToPem(cert);

    // 保存文件
    const keyPath = path.join(certsDir, 'key.pem');
    const certPath = path.join(certsDir, 'cert.pem');
    
    console.log('保存私钥到:', keyPath);
    fs.writeFileSync(keyPath, privateKeyPem);
    
    console.log('保存证书到:', certPath);
    fs.writeFileSync(certPath, certPem);

    console.log('证书生成成功！');
} catch (error) {
    console.error('生成证书时出错:', error);
} 