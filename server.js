const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

let directoryUsers = [];
let globalBlocks = {}; // ব্লক ডাটা স্টোর

app.post('/api/login', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ message: "Name is required" });
  
  const exists = directoryUsers.some(u => u.name.toLowerCase() === name.trim().toLowerCase());
  if (exists) {
    return res.status(400).json({ message: "Nickname already taken active in directory!" });
  }
  res.status(200).json({ message: "Success" });
});

io.on('connection', (socket) => {
  console.log(`User Connected: ${socket.id}`);

  socket.on('join_directory', (userData) => {
    socket.username = userData.name;
    directoryUsers = directoryUsers.filter(u => u.name !== userData.name);
    
    const newUser = { id: socket.id, ...userData };
    directoryUsers.push(newUser);
    
    io.emit('update_directory', directoryUsers);
    // নতুন ইউজার জয়েন করলে বর্তমান গ্লোবাল ব্লক লিস্ট পাঠানো
    socket.emit('sync_global_blocks', globalBlocks);
  });

  // ব্লক ইউজার ইভেন্ট
  socket.on('block_user_global', ({ blockerName, blockedName }) => {
    if (!globalBlocks[blockerName]) globalBlocks[blockerName] = [];
    if (!globalBlocks[blockerName].includes(blockedName)) {
      globalBlocks[blockerName].push(blockedName);
    }
    io.emit('sync_global_blocks', globalBlocks);
  });

  // আনব্লক ইউজার ইভেন্ট
  socket.on('unblock_user_global', ({ blockerName, blockedName }) => {
    if (globalBlocks[blockerName]) {
      globalBlocks[blockerName] = globalBlocks[blockerName].filter(name => name !== blockedName);
    }
    io.emit('sync_global_blocks', globalBlocks);
  });

  socket.on('send_private_message', ({ toSocketId, message, msgId, fileType, timestamp }) => {
    socket.to(toSocketId).emit('receive_private_message', {
      fromSocketId: socket.id,
      senderName: socket.username,
      message,
      msgId,
      fileType,
      timestamp
    });
  });

  socket.on('message_delivery_ack', ({ toSocketId, fromName, msgId, isSeen }) => {
    socket.to(toSocketId).emit('receive_delivery_ack', {
      fromName,
      msgId,
      isSeen
    });
  });

  socket.on('chat_opened_or_seen', ({ fromName, toSocketId }) => {
    socket.to(toSocketId).emit('partner_marked_seen', {
      fromName
    });
  });

  socket.on('typing_status', ({ toSocketId, isTyping, senderName }) => {
    socket.to(toSocketId).emit('receive_typing_status', {
      senderName,
      isTyping
    });
  });

  socket.on('delete_message_global', ({ toSocketId, msgId }) => {
    socket.to(toSocketId).emit('message_deleted_global', { msgId });
  });

  socket.on('edit_message_global', ({ toSocketId, msgId, newText }) => {
    socket.to(toSocketId).emit('message_edited_global', { msgId, newText });
  });

  socket.on('disconnect', () => {
    console.log(`User Disconnected: ${socket.id}`);
    directoryUsers = directoryUsers.filter(u => u.id !== socket.id);
    io.emit('update_directory', directoryUsers);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Backend Server running on port ${PORT}`));