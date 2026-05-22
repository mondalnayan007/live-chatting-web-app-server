const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
// ১. গুগল অথেন্টিকেশন লাইব্রেরি ইম্পোর্ট করা হলো
const { OAuth2Client } = require('google-auth-library');

const app = express();
const server = http.createServer(app);

// ফ্রন্টএন্ডে যে ক্লায়েন্ট আইডি ব্যবহার করেছেন, সেটিই এখানে বসান
const GOOGLE_CLIENT_ID = "550936863221-hnd1i9amld9vsijieom0g3nm414g4h8p.apps.googleusercontent.com";
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // ইমেজ/ফাইল শেয়ারিং এর জন্য লিমিট বাড়ানো হলো

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || "YOUR_MONGODB_CONNECTION_STRING_HERE";
mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB Connected Successfully!"))
  .catch(err => console.error("MongoDB Connection Failed:", err));

// User Schema & Model
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  age: { type: Number, required: true },
  country: { type: String, default: 'Bangladesh' },
  gender: { type: String, default: 'Male' },
  profilePic: { type: String, default: '' },
  isGuest: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// Global Active Users Directory & Blocks State
let activeUsersDirectory = [];
let globalBlocks = {}; // Structure: { "UserA": ["UserB", "UserC"] }

// ------------------- API ROUTES -------------------

// প্রধান এবং আপডেট করা লগইন এপিআই রাউট
app.post('/api/login', async (req, res) => {
  try {
    const { name, age, country, gender, profilePic, isGuest } = req.body;

    // কেইস ১: ইউজার যদি গুগল দিয়ে লগইন করতে চায় (isGuest === false)
    if (isGuest === false) {
      if (!age) {
        return res.status(400).json({ message: "Age, Country, and Gender are required before Google Login!" });
      }

      // মঙ্গোডিবিতে চেক করুন এই গুগল ইউজারটি আগে থেকেই রেজিস্টার্ড কিনা
      let existingUser = await User.findOne({ name: name, isGuest: false });
      
      if (!existingUser) {
        // নতুন পার্মানেন্ট ইউজার তৈরি করুন (যা ক্রন-জব বা ক্র্যাশ লজিকে ডিলিট হবে না)
        existingUser = new User({
          name,
          age,
          country,
          gender,
          profilePic,
          isGuest: false 
        });
        await existingUser.save();
      }

      return res.status(200).json({ message: "Google Authentication Successful", user: existingUser });
    }

    // কেইস ২: ইউজার যদি গেস্ট হিসেবে লগইন করে (isGuest === true)
    if (!name || !age) {
      return res.status(400).json({ message: "Nickname and Age are required for Guest Login!" });
    }

    // একটি ডামি বা কাস্টম ইমেজ সেট করা যদি ইউজার আপলোড না করে
    const finalPic = profilePic || (gender === 'Female' ? 'ICON_FEMALE' : 'ICON_MALE');

    let guestUser = new User({ 
      name: name.trim(), 
      age, 
      country, 
      gender, 
      profilePic: finalPic, 
      isGuest: true 
    });
    await guestUser.save();
    
    return res.status(200).json({ message: "Guest Login Successful", user: guestUser });

  } catch (error) {
    console.error("Login Router Error:", error);
    res.status(500).json({ message: "Internal Server Error during Authentication" });
  }
});


// ------------------- SOCKET.IO REAL-TIME CHAT -------------------
const io = new Server(server, {
  cors: {
    origin: "*", // প্রোডাকশনে আপনার নির্দিষ্ট ফ্রন্টএন্ড ইউআরএল দিতে পারেন
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // ১. ডিরেক্টরিতে জয়েন করা
  socket.on('join_directory', (userData) => {
    if (!userData || !userData.name) return;

    // আগের কোনো সেশন থাকলে ডিলিট করে নতুন সেশন পুশ করা
    activeUsersDirectory = activeUsersDirectory.filter(u => u.name !== userData.name);
    
    activeUsersDirectory.push({
      id: socket.id,
      name: userData.name,
      age: userData.age,
      country: userData.country,
      gender: userData.gender,
      profilePic: userData.profilePic,
      isGuest: userData.isGuest
    });

    socket.username = userData.name;

    // সবাইকে নতুন ইউজার লিস্ট এবং ব্লক লিস্ট পাঠানো
    io.emit('update_directory', activeUsersDirectory);
    io.emit('sync_global_blocks', globalBlocks);
  });

  // ২. প্রাইভেট মেসেজ পাঠানো
  socket.on('send_private_message', ({ toSocketId, message, msgId, fileType, timestamp }) => {
    const senderName = socket.username;
    if (!senderName) return;

    // রিসিভার ব্লকড লিস্টে আছে কিনা চেক করা (উভয় পক্ষ থেকে)
    const targetUser = activeUsersDirectory.find(u => u.id === toSocketId);
    if (targetUser) {
      const iBlockHim = globalBlocks[senderName] && globalBlocks[senderName].includes(targetUser.name);
      const heBlocksMe = globalBlocks[targetUser.name] && globalBlocks[targetUser.name].includes(senderName);
      
      if (iBlockHim || heBlocksMe) return; // ব্লকড থাকলে মেসেজ ড্রপ হবে
    }

    // মেসেজটি রিসিভারের কাছে পাঠানো
    socket.to(toSocketId).emit('receive_private_message', {
      fromSocketId: socket.id,
      senderName,
      message,
      msgId,
      fileType: fileType || 'text',
      timestamp
    });
  });

  // ৩. মেসেজ ডেলিভারি এবং সিন (Seen) স্ট্যাটাস একনলেজমেন্ট
  socket.on('message_delivery_ack', ({ toSocketId, fromName, msgId, isSeen }) => {
    socket.to(toSocketId).emit('receive_delivery_ack', {
      fromName,
      msgId,
      isSeen
    });
  });

  socket.on('chat_opened_or_seen', ({ fromName, toSocketId }) => {
    socket.to(toSocketId).emit('partner_marked_seen', { fromName });
  });

  // ৪. টাইপিং স্ট্যাটাস (Typing Indicators)
  socket.on('typing_status', ({ toSocketId, isTyping, senderName }) => {
    socket.to(toSocketId).emit('receive_typing_status', { senderName, isTyping });
  });

  // ৫. মেসেজ আনসেন্ড (Delete Global)
  socket.on('delete_message_global', ({ toSocketId, msgId }) => {
    socket.to(toSocketId).emit('message_deleted_global', { msgId });
  });

  // ৬. মেসেজ এডিট (Edit Global)
  socket.on('edit_message_global', ({ toSocketId, msgId, newText }) => {
    socket.to(toSocketId).emit('message_edited_global', { msgId, newText });
  });

  // ৭. গ্লোবাল ব্লক এবং আনব্লক লজিক
  socket.on('block_user_global', ({ blockerName, blockedName }) => {
    if (!globalBlocks[blockerName]) globalBlocks[blockerName] = [];
    if (!globalBlocks[blockerName].includes(blockedName)) {
      globalBlocks[blockerName].push(blockedName);
    }
    io.emit('sync_global_blocks', globalBlocks);
  });

  socket.on('unblock_user_global', ({ blockerName, blockedName }) => {
    if (globalBlocks[blockerName]) {
      globalBlocks[blockerName] = globalBlocks[blockerName].filter(name => name !== blockedName);
    }
    io.emit('sync_global_blocks', globalBlocks);
  });

  // ৮. ডিসকানেক্ট হ্যান্ডলার
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    activeUsersDirectory = activeUsersDirectory.filter(u => u.id !== socket.id);
    io.emit('update_directory', activeUsersDirectory);
  });
});

// ------------------- SERVER BOOTUP -------------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Chat Channel Backend Server is running fine on port ${PORT}`);
});