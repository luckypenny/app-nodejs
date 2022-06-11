const { createServer } = require('http');
const { Server } = require('socket.io');
const { instrument } = require('@socket.io/admin-ui');
const path = require('path');
const express = require('express');
const router = express.Router();
// require('@socket.io/admin-ui/ui/dist');

//const app = require('express')();
const app = express();
const admin_socket_io = express();

admin_socket_io.use('/', express.static(path.join(__dirname, '../../node_modules/@socket.io/admin-ui/ui/dist')));
app.get('/', function (req, res) {
  res.end('socket-caster is alive');
});

const httpServer = createServer(app);

const io = new Server(httpServer, {
  // cors: {
  //   origin: ['https://admin.socket.io'],
  //   credentials: true,
  // },
  cors: {
    origin: ['*', 'https://admin.socket.io'],
    credentials: false,
  },
});

instrument(io, {
  auth: false,
});

httpServer.listen(8082);
admin_socket_io.listen(3000);
// scripts 경로로 접근시 node_modules을 사용할 수 있게 설정
