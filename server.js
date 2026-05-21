const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// সকেট কনফিগারেশন
const io = new Server(server, {
  cors: {
    origin: "*", // লোকাল এবং প্রোডাকশন সব ফ্রন্টএন্ডের জন্য ওপেন রাখা হলো
    methods: ["GET", "POST"]
  }
});

let directoryUsers = [];
let globalBlocks = {};

// লগইন এপিআই
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

  // ইউজারের ডিরেক্টরিতে জয়েন করা
  socket.on('join_directory', (userData) => {
    socket.username = userData.name;
    
    // আগের কোনো সেশন থাকলে ক্লিয়ার করা
    directoryUsers = directoryUsers.filter(u => u.name !== userData.name);
    
    const newUser = { id: socket.id, ...userData };
    directoryUsers.push(newUser);
    
    // সবাইকে আপডেট পাঠানো
    io.emit('update_directory', directoryUsers);
    socket.emit('sync_global_blocks', globalBlocks);
  });

  // রিয়েল-টাইম প্রাইভেট মেসেজ রাউটিং
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

  // ডাবল টিক (Delivery / Seen ACK) লজিক
  socket.on('message_delivery_ack', ({ toSocketId, fromName, msgId, isSeen }) => {
    socket.to(toSocketId).emit('receive_delivery_ack', {
      fromName,
      msgId,
      isSeen
    });
  });

  // চ্যাট বক্স ওপেন করলে ব্লু টিক ট্রিগার
  socket.on('chat_opened_or_seen', ({ fromName, toSocketId }) => {
    socket.to(toSocketId).emit('partner_marked_seen', {
      fromName
    });
  });

  // লাইভ টাইপিং ইন্ডিকেটর
  socket.on('typing_status', ({ toSocketId, isTyping, senderName }) => {
    socket.to(toSocketId).emit('receive_typing_status', {
      senderName,
      isTyping
    });
  });

  // গ্লোবাল আনসেন্ড
  socket.on('delete_message_global', ({ toSocketId, msgId }) => {
    socket.to(toSocketId).emit('message_deleted_global', { msgId });
  });

  // গ্লোবাল এডিট
  socket.on('edit_message_global', ({ toSocketId, msgId, newText }) => {
    socket.to(toSocketId).emit('message_edited_global', { msgId, newText });
  });

  // ডিসকানেক্ট হ্যান্ডলার
  socket.on('disconnect', () => {
    console.log(`User Disconnected: ${socket.id}`);
    directoryUsers = directoryUsers.filter(u => u.id !== socket.id);
    io.emit('update_directory', directoryUsers);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Backend Server running on port ${PORT}`));