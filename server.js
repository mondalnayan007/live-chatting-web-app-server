const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
// CORS কনফিগারেশন নিশ্চিত করুন
app.use(cors({
  origin: "http://localhost:5173",
  methods: ["GET", "POST"]
}));
app.use(express.json());

const server = http.createServer(app);

// Socket.io Setup
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

// গ্লোবাল ডাটা স্টোর
let directoryUsers = []; // [{ id, name, age, country, gender, profilePic }]
let globalBlocks = {};   // { nickname: [blockedNicknames] }

// --- HTTP API ROUTE FOR LOGIN ---
app.post('/api/login', (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, message: "Nickname is required." });
  }

  // চেক করা হচ্ছে এই নামের কোনো ইউজার অলরেডি ডিরেক্টরিতে আছে কিনা
  const isNameTaken = directoryUsers.some(
    u => u.name.toLowerCase().trim() === name.toLowerCase().trim()
  );

  if (isNameTaken) {
    return res.status(400).json({ 
      success: false, 
      message: `The nickname "${name}" is already taken. Please choose another name.` 
    });
  }

  // নাম ইউনিক হলে সাকসেস রিটার্ন করা হচ্ছে
  return res.status(200).json({ success: true });
});


// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
  console.log(`⚡ A user connected: ${socket.id}`);

  // ডিরেক্টরিতে জয়েন করা (সকেট সেশন ম্যাপিং)
  socket.on('join_directory', (userData) => {
    if (!userData || !userData.name) return;

    // আগের কোনো সেশন থাকলে রিমুভ করে নতুন সকেটে আপডেট করা
    directoryUsers = directoryUsers.filter(u => u.name !== userData.name);
    
    const newUser = {
      id: socket.id,
      name: userData.name,
      age: userData.age,
      country: userData.country,
      gender: userData.gender,
      profilePic: userData.profilePic
    };

    directoryUsers.push(newUser);

    // সব ইউজারকে অ্যাক্টিভ ডিরেক্টরি লিস্ট এবং ব্লক লিস্ট পাঠানো
    io.emit('update_directory', directoryUsers);
    io.emit('sync_global_blocks', globalBlocks);
  });

  // প্রাইভেট মেসেজ আদান-প্রদান
  socket.on('send_private_message', ({ toSocketId, message, msgId, fileType }) => {
    const sender = directoryUsers.find(u => u.id === socket.id);
    if (!sender) return;

    socket.to(toSocketId).emit('receive_private_message', {
      fromSocketId: socket.id,
      senderName: sender.name,
      message,
      msgId,
      fileType: fileType || 'text'
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

  // ইউজার ব্লক করার লজিক
  socket.on('block_user_action', ({ blockerName, blockedName }) => {
    if (!globalBlocks[blockerName]) globalBlocks[blockerName] = [];
    if (!globalBlocks[blockerName].includes(blockedName)) {
      globalBlocks[blockerName].push(blockedName);
    }
    io.emit('sync_global_blocks', globalBlocks);
  });

  // ইউজার আনব্লক করার লজিক
  socket.on('unblock_user_action', ({ blockerName, blockedName }) => {
    if (globalBlocks[blockerName]) {
      globalBlocks[blockerName] = globalBlocks[blockerName].filter(name => name !== blockedName);
    }
    io.emit('sync_global_blocks', globalBlocks);
  });

  // ডিসকানেক্ট হ্যান্ডলার
  socket.on('disconnect', () => {
    console.log(`❌ User disconnected: ${socket.id}`);
    directoryUsers = directoryUsers.filter(u => u.id !== socket.id);
    io.emit('update_directory', directoryUsers);
  });
});

const PORT = 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});