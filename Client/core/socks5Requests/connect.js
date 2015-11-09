//--------------------------------------------- 
// Copyright(c) 2015 SunshinyNeko Written by VSCode
//--------------------------------------------- 

'use strict'

const os = require('os');
const net = require('net');
const util = require('util');
const crypto = require('crypto');
const socks5Helper = require('./helpers');
const socks5Const = require('../socks5Const');
const logger = require('winston');

/**
 * options: {
 *    proxySocket,
 *    cipherAlgorithm,
 *    password
 * }
 * 
 * callback: (err, cipherKey, verificationNum) => void
 */
function negotiateCipher(options, callback) {
  let proxySocket = options.proxySocket;
  let cipherAlgorithm = options.cipherAlgorithm;
  let password = options.password;
  
  let sha = crypto.createHash('sha256');
  sha.update((Math.random() * Date.now()).toString());
  let cipherKey = sha.digest().toString('hex');
  
  let verificationNum = Number((Math.random() * Date.now()).toFixed());
  
  // Build negotiation object
  let handshake = {
    cipherKey,
    cipherAlgorithm,
    verificationNum,
    randomPadding: Math.random() * Date.now(),
    lightSword: '0.0.1'
  };
  
  proxySocket.once('data', (data) => {
    let handshakeDecipher = crypto.createDecipher(cipherAlgorithm, cipherKey);
    let buf = Buffer.concat([handshakeDecipher.update(data), handshakeDecipher.final()]);
    
    try {
      let res = JSON.parse(buf.toString('utf8'));
      let okNum = Number(res.okNum);
      if (okNum !== verificationNum + 1) return callback(new Error("Can't confirm verification number"));

      callback(null, cipherKey, okNum);
    } catch(ex) {
      logger.error(ex.message);
      callback(ex);
    }
  });
  
  let handshakeCipher = crypto.createCipher(cipherAlgorithm, password);
  let hello = Buffer.concat([handshakeCipher.update(JSON.stringify(handshake)), handshakeCipher.final()]);
  proxySocket.write(hello);
}

function handleCommunication(options, connectCallback) {
  let clientSocket = options.clientSocket;
  let proxySocket = options.proxySocket;
  let cipherAlgorithm = options.cipherAlgorithm;
  let cipherKey = options.cipherKey;
  
  let dstAddr = options.dstAddr;
  let dstPort = options.dstPort;
  let verificationNum = options.verificationNum;
  
  let connect = {
    dstAddr,
    dstPort,
    verificationNum,
    type: 'connect'
  };
  
  let cipher = crypto.createCipher(cipherAlgorithm, cipherKey);  
  let connectBuffer = cipher.update(JSON.stringify(connect));
  proxySocket.write(connectBuffer);
  
  proxySocket.once('data', (data) => {
    let decipher = crypto.createDecipher(cipherAlgorithm, cipherKey);  
    let connectOk = decipher.update(data).toString();
    logger.info(connectOk);
    connectCallback(connectOk);
  
    proxySocket.on('data', data => {
      let decipher = crypto.createDecipher(cipherAlgorithm, cipherKey); 
      clientSocket.write(Buffer.concat([decipher.update(data), decipher.final()]));
      // logger.info('Client received: ' + data.length);
      // clientSocket.write(data);
    });
    
    clientSocket.on('data', (data) => {
      let cipher = crypto.createCipher(cipherAlgorithm, cipherKey);
      proxySocket.write(Buffer.concat([cipher.update(data), cipher.final()]));
      // logger.info('Client write: ' + data.byteLength + data)
      // proxySocket.write(data);
    });    
  });
  
  clientSocket.on('end', () => proxySocket.end());
  proxySocket.on('end', () => clientSocket.end());
  
  clientSocket.on('error', (err) => proxySocket.end());
  proxySocket.on('error', (error) => clientSocket.end());
}

/**
 * options: {
 *    clientSocket,
 *    timeout?,
 *    lsAddr,
 *    lsPort,
 *    cipherAlgorithm,
 *    password,
 *    dstAddr,
 *    dstPort
 * }
 */
function handleConnect(options) {

  socks5Helper.getDefaultSocks5Reply((buf) => {
    let clientSocket = options.clientSocket;
    let timeout = options.timeout ? options.timeout : 60;
    let lsAddr = options.lsAddr;
    let lsPort = options.lsPort;
    
    // Step1: Connect to LightSword Server
    let proxySocket = net.createConnection(lsPort, lsAddr, () => {
      logger.info('proxy connected');
      
      let negotiationOptions = {
        proxySocket: proxySocket,
        password: options.password,
        cipherAlgorithm: options.cipherAlgorithm
      };
      
      // Step2: Negotiate cipher with LightSword Server
      let negotiation = new Promise((resolve, reject) => {
        negotiateCipher(negotiationOptions, (err, cipherKey, vn) => {
          if (err) return reject(err);
          resolve({ cipherKey, vn });          
        });
      });
      
      // Step3: Send dstAddr, dstPort and communicate with LightServer
      negotiation.then((secret) => {
        let connectOptions = {};
        connectOptions.dstAddr = options.dstAddr;
        connectOptions.dstPort = options.dstPort;
        connectOptions.cipherAlgorithm = options.cipherAlgorithm;
        
        connectOptions.clientSocket = clientSocket;
        connectOptions.proxySocket = proxySocket;
        connectOptions.cipherKey = secret.cipherKey;
        connectOptions.verificationNum = secret.vn;
        
        handleCommunication(connectOptions, (ok) => {
          // Reply client socks5 connection succeed
          buf.writeUInt16BE(options.dstPort, buf.byteLength - 2);
          buf[1] = socks5Const.REPLY_CODE.SUCCESS;
          clientSocket.write(buf);
        });

      }, (err) => {
        logger.error(err);
        
        buf[1] = socks5Const.REPLY_CODE.SOCKS_SERVER_FAILURE;        
        proxySocket.end();
        return clientSocket.end(buf);
      });
    });
    
    proxySocket.on('error', (err) => { 
      logger.error(err);
    });
    proxySocket.setTimeout(timeout * 1000);
  });
  
}

module.exports = handleConnect;