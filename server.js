const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// ==========================================
// MONGODB ATLAS CONNECTION
// ==========================================
// পরিবেশ ভেরিয়েবল (Environment Variable) থেকে MONGO_URI নিবে, না থাকলে লোকালটা ব্যবহার করবে
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/liveChatApp";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✓ MongoDB Atlas Connected Successfully!"))
  .catch((err) => console.error("✗ MongoDB Connection Error:", err));

// ==========================================
// MONGOOSE SCHEMAS & MODELS
// ==========================================
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  age: String,
  country: String,
  gender: String,
  profilePic: String,
  isGuest: { type: Boolean, default: true }, // true = Guest (Auto delete), false = Permanent (Email Verified)
  socketId: String
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  msgId: { type: String, required: true, unique: true },
  sender: String,       // Nickname
  receiver: String,     // Nickname
  text: String,
  fileType: { type: String, default: 'text' },
  time: String,
  status: { type: String, default: 'sent' }, // sent, delivered, seen
  isUnsent: { type: Boolean, default: false },
  isEdited: { type: Boolean, default: false }
}, { timestamps: true });

const blockSchema = new mongoose.Schema({
  blockerName: String,
  blockedName: String
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const Block = mongoose.model('Block', blockSchema);

// ==========================================
// SOCKET.IO CONFIGURATION
// ==========================================
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e7 // ইমেজ আপলোডের জন্য বাফার সাইজ বাড়িয়ে ১০ MB করা হলো (মেমোরি সেভ হবে ডাটাবেজে)
});

// ==========================================
// LOGIN API (GUEST & PERMANENT FILTER)
// ==========================================
app.post('/api/login', async (req, res) => {
  const { name, age, country, gender, profilePic, isGuest } = req.body;
  if (!name) return res.status(400).json({ message: "Name is required" });
  
  try {
    const trimmedName = name.trim();
    // কেস-ইনসেনসিটিভ চেক (একই নামের ইউজার অলরেডি ডাটাবেজে একটিভ আছে কিনা)
    const exists = await User.findOne({ name: { $regex: new RegExp(`^${trimmedName}$`, 'i') } });
    
    if (exists) {
      return res.status(400).json({ message: "Nickname already taken or active in directory!" });
    }

    // নতুন ইউজার মঙ্গোডিবিতে সেভ হচ্ছে (সাময়িকভাবে হলেও ডেটাবেজে থাকবে রিফ্রেশ প্রোটেকশনের জন্য)
    const newUser = new User({
      name: trimmedName,
      age,
      country,
      gender,
      profilePic,
      isGuest: isGuest !== undefined ? isGuest : true // ডিফল্ট গেস্ট হিসেবে সেট হবে
    });
    
    await newUser.save();
    res.status(200).json({ message: "Success", user: newUser });
  } catch (error) {
    res.status(500).json({ message: "Server error during login" });
  }
});

// ==========================================
// REAL-TIME SOCKET EVENTS
// ==========================================
io.on('connection', (socket) => {
  console.log(`User Connected: ${socket.id}`);

  // ইউজারের ডিরেক্টরিতে জয়েন করা
  socket.on('join_directory', async (userData) => {
    try {
      socket.username = userData.name;
      
      // ডাটাবেজে সকেট আইডি আপডেট করা
      await User.findOneAndUpdate({ name: userData.name }, { socketId: socket.id });
      
      // অল অ্যাক্টিভ ইউজার লিস্ট মঙ্গোডিবি থেকে নিয়ে আসা
      const activeUsers = await User.find({}, 'id name age country gender profilePic isGuest socketId');
      
      // সকেট ডিরেক্টরি ফরম্যাটে ম্যাপ করা (ফ্রন্টএন্ডের আগের কোড ঠিক রাখার জন্য)
      const directoryUsers = activeUsers.map(u => ({
        id: u.socketId || u._id,
        name: u.name,
        age: u.age,
        country: u.country,
        gender: u.gender,
        profilePic: u.profilePic,
        isGuest: u.isGuest
      }));

      // সবাইকে ডিরেক্টরি আপডেট পাঠানো
      io.emit('update_directory', directoryUsers);

      // ব্লক লিস্ট সিঙ্ক করা
      const allBlocksData = await Block.find({});
      const globalBlocks = {};
      allBlocksData.forEach(b => {
        if (!globalBlocks[b.blockerName]) globalBlocks[b.blockerName] = [];
        globalBlocks[b.blockerName].push(b.blockedName);
      });
      socket.emit('sync_global_blocks', globalBlocks);

      // ইউজার জয়েন করার সাথে সাথে ডাটাবেজ থেকে তার আগের চ্যাট হিস্ট্রি ফ্রন্টএন্ডে পুশ করা (যদি পার্মানেন্ট ইউজার হয়)
      const userChats = await Message.find({
        $or: [{ sender: userData.name }, { receiver: userData.name }]
      }).sort({ createdAt: 1 });
      
      // ফ্রন্টএন্ড যেভাবে হিস্ট্রি এক্সপেক্ট করে সেভাবে স্ট্রাকচার করা
      const historyObject = {};
      userChats.forEach(msg => {
        const partner = msg.sender === userData.name ? msg.receiver : msg.sender;
        if (!historyObject[partner]) historyObject[partner] = [];
        historyObject[partner].push({
          id: msg.msgId,
          sender: msg.sender === userData.name ? 'You' : msg.sender,
          text: msg.text,
          type: msg.sender === userData.name ? 'outgoing' : 'incoming',
          fileType: msg.fileType,
          time: msg.time,
          status: msg.status,
          isUnsent: msg.isUnsent,
          isEdited: msg.isEdited
        });
      });
      socket.emit('load_chat_history_from_db', historyObject);

    } catch (err) {
      console.error(err);
    }
  });

  // রিয়েল-টাইম প্রাইভেট মেসেজ রাউটিং এবং মঙ্গোডিবিতে সেভ
  socket.on('send_private_message', async ({ toSocketId, message, msgId, fileType, timestamp }) => {
    try {
      const receiverUser = await User.findOne({ $or: [{ socketId: toSocketId }, { _id: toSocketId }] });
      const receiverName = receiverUser ? receiverUser.name : "Unknown";

      // মঙ্গোডিবি ডাটাবেজে স্থায়ীভাবে মেসেজ বা ইমেজের Base64 স্টোর করা (No Storage Error!)
      const newMsg = new Message({
        msgId,
        sender: socket.username,
        receiver: receiverName,
        text: message,
        fileType: fileType || 'text',
        time: timestamp,
        status: 'sent'
      });
      await newMsg.save();

      socket.to(toSocketId).emit('receive_private_message', {
        fromSocketId: socket.id,
        senderName: socket.username,
        message,
        msgId,
        fileType,
        timestamp
      });
    } catch (err) {
      console.error("Message save error:", err);
    }
  });

  // ডাবল টিক (Delivery / Seen ACK) লজিক ও ডাটাবেজ স্ট্যাটাস আপডেট
  socket.on('message_delivery_ack', async ({ toSocketId, fromName, msgId, isSeen }) => {
    try {
      const statusStr = isSeen ? 'seen' : 'delivered';
      await Message.findOneAndUpdate({ msgId }, { status: statusStr });

      socket.to(toSocketId).emit('receive_delivery_ack', {
        fromName,
        msgId,
        isSeen
      });
    } catch (err) { console.error(err); }
  });

  // চ্যাট বক্স ওপেন করলে ব্লু টিক ট্রিগার এবং ডাটাবেজ আপডেট
  socket.on('chat_opened_or_seen', async ({ fromName, toSocketId }) => {
    try {
      const partnerUser = await User.findOne({ $or: [{ socketId: toSocketId }, { _id: toSocketId }] });
      if (partnerUser) {
        await Message.updateMany(
          { sender: partnerUser.name, receiver: fromName, status: { $ne: 'seen' } },
          { status: 'seen' }
        );
      }
      socket.to(toSocketId).emit('partner_marked_seen', { fromName });
    } catch (err) { console.error(err); }
  });

  // লাইভ টাইপিং ইন্ডিকেটর
  socket.on('typing_status', ({ toSocketId, isTyping, senderName }) => {
    socket.to(toSocketId).emit('receive_typing_status', { senderName, isTyping });
  });

  // গ্লোবাল আনসেন্ড (ডাটাবেজেও ফ্ল্যাগ আপডেট হবে)
  socket.on('delete_message_global', async ({ toSocketId, msgId }) => {
    try {
      await Message.findOneAndUpdate({ msgId }, { isUnsent: true, text: "🚫 This message was unsent" });
      socket.to(toSocketId).emit('message_deleted_global', { msgId });
    } catch (err) { console.error(err); }
  });

  // গ্লোবাল এডিট (ডাটাবেজে টেক্সট আপডেট হবে)
  socket.on('edit_message_global', async ({ toSocketId, msgId, newText }) => {
    try {
      await Message.findOneAndUpdate({ msgId }, { text: newText, isEdited: true });
      socket.to(toSocketId).emit('message_edited_global', { msgId, newText });
    } catch (err) { console.error(err); }
  });

  // গ্লোবাল ব্লক হ্যান্ডলার
  socket.on('block_user_global', async ({ blockerName, blockedName }) => {
    try {
      await Block.findOneAndUpdate({ blockerName, blockedName }, { blockerName, blockedName }, { upsert: true });
      // পুনরায় সিঙ্ক পাঠানো
      triggerGlobalBlockSync();
    } catch (err) { console.error(err); }
  });

  socket.on('unblock_user_global', async ({ blockerName, blockedName }) => {
    try {
      await Block.deleteOne({ blockerName, blockedName });
      triggerGlobalBlockSync();
    } catch (err) { console.error(err); }
  });

  async function triggerGlobalBlockSync() {
    const allBlocksData = await Block.find({});
    const globalBlocks = {};
    allBlocksData.forEach(b => {
      if (!globalBlocks[b.blockerName]) globalBlocks[b.blockerName] = [];
      globalBlocks[b.blockerName].push(b.blockedName);
    });
    io.emit('sync_global_blocks', globalBlocks);
  }

  // ==========================================
  // DISCONNECT HANDLER (GUEST AUTOMATIC CLEAN UP)
  // ==========================================
  socket.on('disconnect', async () => {
    console.log(`User Disconnected: ${socket.id}`);
    try {
      // প্রথমে চেক করা হচ্ছে ডিসকানেক্ট হওয়া ইউজারটি Guest নাকি Permanent
      const disconnectedUser = await User.findOne({ socketId: socket.id });
      
      if (disconnectedUser) {
        if (disconnectedUser.isGuest) {
          // লজিক অনুযায়ী: গেস্ট হলে ডাটাবেজ থেকে তার প্রোফাইল সম্পূর্ণ ভ্যানিশ করা হবে
          await User.deleteOne({ _id: disconnectedUser._id });
          
          // গেস্টের পাঠানো এবং তার কাছে আসা সমস্ত চ্যাট হিস্ট্রিও ডাটাবেজ থেকে ক্লিন করে দেওয়া হবে
          await Message.deleteMany({
            $or: [{ sender: disconnectedUser.name }, { receiver: disconnectedUser.name }]
          });
          
          console.log(`🧹 Guest Cleaned Up completely from Database: ${disconnectedUser.name}`);
        } else {
          // ইমেইল বা পার্মানেন্ট ইউজার হলে শুধু সকেট আইডি রিমুভ হবে, প্রোফাইল বা চ্যাট ডিলিট হবে না
          await User.findOneAndUpdate({ _id: disconnectedUser._id }, { socketId: null });
          console.log(`🔒 Permanent user went offline: ${disconnectedUser.name}`);
        }
      }

      // বাকি একটিভ ইউজারদের ফ্রন্টএন্ড ডিরেক্টরি রিফ্রেশ করা
      const activeUsers = await User.find({});
      const directoryUsers = activeUsers.map(u => ({
        id: u.socketId || u._id,
        name: u.name,
        age: u.age,
        country: u.country,
        gender: u.gender,
        profilePic: u.profilePic,
        isGuest: u.isGuest
      }));
      io.emit('update_directory', directoryUsers);

    } catch (err) {
      console.error("Disconnect cleanup error:", err);
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Backend Server running on port ${PORT}`));