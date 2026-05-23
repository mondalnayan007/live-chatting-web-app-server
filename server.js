require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { MongoClient } = require('mongodb'); 
const { OAuth2Client } = require('google-auth-library');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const server = http.createServer(app);

const GOOGLE_CLIENT_ID = "550936863221-hnd1i9amld9vsijieom0g3nm414g4h8p.apps.googleusercontent.com";
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// Middleware
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));

// MongoDB Connection
const MONGO_URI = "mongodb+srv://user:HelloNayan007@cluster0.kc2s7sf.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const dbName = "chat_app"; 
let db, usersCollection, messagesCollection;

// 🔒 জেמיני এপিআই কি কনফিগারেশন
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
let aiClient = null;

if (GEMINI_API_KEY) {
  try {
    // ✅ সঠিক কনস্ট্রাক্টর GoogleGenerativeAI কল করা হলো
    aiClient = new GoogleGenerativeAI(GEMINI_API_KEY); 
    console.log("✅ Gemini AI Client successfully configured using GoogleGenerativeAI!");
  } catch (err) {
    console.error("❌ Gemini Initialization Error:", err.message);
  }
} else {
  console.log("⚠️ Warning: GEMINI_API_KEY is missing in .env file!");
}

MongoClient.connect(MONGO_URI)
  .then(clientInstance => {
    db = clientInstance.db(dbName);
    usersCollection = db.collection("users"); 
    messagesCollection = db.collection("messages"); 
    console.log(`🎉 Pure MongoDB Driver Connected! Database: '${dbName}'`);
  })
  .catch(err => console.error("❌ MongoDB Connection Failed:", err));




let activeUsersDirectory = [];
let globalBlocks = {}; 
let disconnectTimeouts = {}; // 🌟 রিফ্রেশ ট্র্যাকিংয়ের জন্য গ্লোবাল অবজেক্ট

// ------------------- API ROUTES -------------------
app.post('/api/login', async (req, res) => {
  try {
    if (!usersCollection) {
      return res.status(500).json({ message: "Database not ready yet!" });
    }

    const { name, age, country, gender, profilePic, isGuest } = req.body;
    const checkGuest = (isGuest === true || isGuest === 'true');

    if (!checkGuest) {
      if (!age) return res.status(400).json({ message: "Age is required!" });

      let existingUser = await usersCollection.findOne({ name: name, isGuest: false });
      if (!existingUser) {
        const newUser = {
          name, age: Number(age), country: country || 'Bangladesh',
          gender: gender || 'Male', profilePic, isGuest: false, createdAt: new Date()
        };
        const result = await usersCollection.insertOne(newUser);
        existingUser = { _id: result.insertedId, ...newUser };
      }
      return res.status(200).json({ message: "Google Login OK", user: existingUser });
    }

    if (!name || !age) {
      return res.status(400).json({ message: "Name and Age are required!" });
    }

    const finalPic = profilePic || (gender === 'Female' ? 'ICON_FEMALE' : 'ICON_MALE');
    let guestUser = await usersCollection.findOne({ name: name.trim(), isGuest: true });

    if (!guestUser) {
      const newGuest = {
        name: name.trim(), age: Number(age), country: country || 'Bangladesh',
        gender: gender || 'Male', profilePic: finalPic, isGuest: true, createdAt: new Date()
      };
      const result = await usersCollection.insertOne(newGuest); 
      guestUser = { _id: result.insertedId, ...newGuest };
      console.log(`🎉 New Guest Saved to usersCollection: ${guestUser.name}`);
    }

    return res.status(200).json({ message: "Guest Login OK", user: guestUser });

  } catch (error) {
    console.error("❌ Direct Login Error:", error.message);
    res.status(500).json({ message: "Server Error" });
  }
});

// ------------------- SOCKET.IO REAL-TIME CHAT -------------------
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 2.5e7 // ২৫ এমবি লিমিট
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // ১. ইউজার যখন ডিরেক্টরিতে জয়েন করবে
  socket.on('join_directory', async (userData) => {
    if (!userData || !userData.name) return;

    const formattedName = userData.name.trim();
    socket.username = formattedName; 
    socket.isGuestUser = (userData.isGuest === true || userData.isGuest === 'true'); 

    // 🛠️ [ফিক্স]: ইউজার যদি রিফ্রেশ দিয়ে ৫ সেকেন্ডের মধ্যে ফিরে আসে, তবে তার মেসেজ ডিলিট হওয়ার টাইমার বাতিল হবে
    if (disconnectTimeouts[formattedName]) {
      clearTimeout(disconnectTimeouts[formattedName]);
      delete disconnectTimeouts[formattedName];
      console.log(`♻️ Deletion Cancelled: '${formattedName}' re-connected via Refresh!`);
    }

    if (usersCollection) {
      try {
        const existingUser = await usersCollection.findOne({ name: formattedName });
        
        if (!existingUser) {
          await usersCollection.insertOne({
            name: formattedName,
            age: userData.age || '',
            country: userData.country || 'Bangladesh',
            gender: userData.gender || 'Male',
            profilePic: userData.profilePic || '',
            isGuest: socket.isGuestUser, 
            createdAt: new Date()
          });
          console.log(`👤 New user registered in usersCollection: ${formattedName}`);
        } else {
          console.log(`🔄 User re-connected: ${formattedName}`);
        }
      } catch (err) {
        console.error("❌ Users কালেকশনে ডাটা রাখতে এরর:", err.message);
      }
    }

    const exists = activeUsersDirectory.some(u => u.name.trim() === formattedName);
    if (!exists) {
      activeUsersDirectory.push({ id: socket.id, name: formattedName, ...userData });
    } else {
      // সকেট আইডি আপডেট করা হলো যাতে রিফ্রেশের পর মেসেজ আদানপ্রদান সচল থাকে
      activeUsersDirectory = activeUsersDirectory.map(u => u.name.trim() === formattedName ? { ...u, id: socket.id } : u);
    }
    io.emit('update_directory', activeUsersDirectory);
  });

  // ২. প্রাইভেট মেসেজ পাঠানো এবং ডাটাবেজে মেসেজ কালেকশনে স্টোর করা
  socket.on('send_private_message', async (data) => {
    const senderName = socket.username || data.senderName;
    if (!senderName) return;

    const { toSocketId, message, msgId, fileType, timestamp } = data;

   // 🌟 [AI Agent চেক]: যদি মেসেজটি AI-এর উদ্দেশ্যে পাঠানো হয়
    if (toSocketId === 'ai_agent' || data.receiverName === '🤖 Chat-AI Bot') {
      console.log(`🤖 AI Agent received a message from ${senderName}: ${message}`);

      // ইউজারকে বোঝানোর জন্য যে AI টাইপ করছে (Typing Status)
      socket.emit('receive_typing_status', { senderName: '🤖 Chat-AI Bot', isTyping: true });

      let aiResponseText = "দুঃখিত, আমি এই মুহূর্তে কিছুটা ব্যস্ত আছি। দয়া করে একটু পর আবার চেষ্টা করুন।";

      try {
        if (aiClient) {
          // Gemini-র স্ট্যান্ডার্ড এবং দ্রুততম মডেল ব্যবহার করা হচ্ছে
          const model = aiClient.getGenerativeModel({ model: "gemini-2.5-flash" });
          
          // AI এর প্রম্পট সেটআপ
          const prompt = `You are a friendly AI Friend named 'Chat-AI Bot' integrated into a real-time chat application. Keep your responses natural, conversational, polite, and relatively short. Reply in the language the user speaks to you (Bengali or English). User says: ${message}`;
          
          // প্যাকেজের নতুন মেথড অনুযায়ী সরাসরি generateContent কল করা হলো
          const result = await model.generateContent(prompt);
          aiResponseText = result.response.text();
        } else {
          aiResponseText = "আমি AI বট, কিন্তু ব্যাকএন্ডে আমার API Key সেট করা হয়নি। অনুগ্রহ করে আপনার .env ফাইলে GEMINI_API_KEY বসান।";
        }
      } catch (aiErr) {
        console.error("❌ Gemini AI Error:", aiErr.message);
        aiResponseText = "ওহ! আমার প্রসেসিংয়ে একটু সমস্যা হয়েছে। আবার একটু বলবেন কি?";
      }

      // AI-এর টাইপিং স্ট্যাটাস বন্ধ করা
      socket.emit('receive_typing_status', { senderName: '🤖 Chat-AI Bot', isTyping: false });

      // ইউজারকে রিয়েল-টাইম AI রেসপন্স পাঠানো
      socket.emit('receive_private_message', {
        fromSocketId: 'ai_agent',
        senderName: '🤖 Chat-AI Bot',
        message: aiResponseText,
        msgId: `ai_msg_${Date.now()}`,
        fileType: 'text',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });

      // 💾 ডাটাবেজে AI চ্যাটের মেসেজ সেভ করা (যাতে পেজ রিফ্রেশ দিলেও চ্যাট হিস্ট্রি থাকে)
      if (messagesCollection) {
        try {
          // ইউজারের মেসেজ সেভ
          await messagesCollection.insertOne({
            msgId: msgId || `msg_${Date.now()}`,
            senderName: senderName,
            receiverName: '🤖 Chat-AI Bot',
            message: message,
            fileType: 'text',
            timestamp: timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            dbTime: new Date()
          });
          // AI এর মেসেজ সেভ
          await messagesCollection.insertOne({
            msgId: `ai_msg_${Date.now()}`,
            senderName: '🤖 Chat-AI Bot',
            receiverName: senderName,
            message: aiResponseText,
            fileType: 'text',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            dbTime: new Date()
          });
          console.log(`💾 AI Chat saved to MongoDB for user: ${senderName}`);
        } catch (e) { 
          console.error("❌ AI Chat DB Save Error:", e.message); 
        }
      }

      return; // 🎯 [ফিক্স ১]: অত্যন্ত জরুরি! AI এর রেসপন্স পাঠানো শেষ হলে ফাংশনটি এখানেই শেষ হবে।
    }

    const targetUser = activeUsersDirectory.find(u => u.id === toSocketId);
    const receiverName = targetUser ? targetUser.name : (data.receiverName || "Unknown");

    if (targetUser) {
      const iBlockHim = globalBlocks[senderName] && globalBlocks[senderName].includes(targetUser.name);
      const heBlocksMe = globalBlocks[targetUser.name] && globalBlocks[targetUser.name].includes(senderName);
      if (iBlockHim || heBlocksMe) return; 
    }

    if (messagesCollection) {
      try {
        const messageDocument = {
          msgId: msgId || `msg_${Date.now()}`,
          senderName: senderName,
          receiverName: receiverName,
          message: message || data.text || "", 
          fileType: fileType || 'text',
          timestamp: timestamp || new Date(),
          dbTime: new Date() // নিখুঁত সর্টিংয়ের জন্য সার্ভার টাইমস্ট্যাম্প
        };

        await messagesCollection.insertOne(messageDocument);
        console.log(`💾 চ্যাট মেসেজ/ইমেজ 'messages' কালেকশনে সেভ হয়েছে! (${senderName} -> ${receiverName})`);
      } catch (dbErr) {
        console.error("❌ ডাটাবেজে মেসেজ সেভ করতে এরর হয়েছে:", dbErr.message);
      }
    }

    if (toSocketId) {
      socket.to(toSocketId).emit('receive_private_message', {
        fromSocketId: socket.id,
        senderName,
        message,
        msgId,
        fileType: fileType || 'text',
        timestamp
      });
    }
  });

  // পুরনো মেসেজ হিস্ট্রি লোড করা
  socket.on('get_chat_history', async ({ sender, receiver }) => {
    if (!messagesCollection) return;
    try {
      const history = await messagesCollection.find({
        $or: [
          { senderName: sender, receiverName: receiver },
          { senderName: receiver, receiverName: sender }
        ]
      }).sort({ dbTime: 1 }).toArray();

      socket.emit('load_chat_history', history);
    } catch (err) {
      console.error("Error fetching history:", err.message);
    }
  });

  socket.on('message_delivery_ack', ({ toSocketId, fromName, msgId, isSeen }) => {
    socket.to(toSocketId).emit('receive_delivery_ack', { fromName, msgId, isSeen });
  });

  socket.on('chat_opened_or_seen', ({ fromName, toSocketId }) => {
    socket.to(toSocketId).emit('partner_marked_seen', { fromName });
  });

  socket.on('typing_status', ({ toSocketId, isTyping, senderName }) => {
    socket.to(toSocketId).emit('receive_typing_status', { senderName, isTyping });
  });

  socket.on('delete_message_global', ({ toSocketId, msgId }) => {
    socket.to(toSocketId).emit('message_deleted_global', { msgId });
  });

  socket.on('edit_message_global', ({ toSocketId, msgId, newText }) => {
    socket.to(toSocketId).emit('message_edited_global', { msgId, newText });
  });

  socket.on('block_user_global', ({ blockerName, blockedName }) => {
    if (!globalBlocks[blockerName]) globalBlocks[blockerName] = [];
    if (!globalBlocks[blockerName].includes(blockedName)) globalBlocks[blockerName].push(blockedName);
    io.emit('sync_global_blocks', globalBlocks);
  });

  socket.on('unblock_user_global', ({ blockerName, blockedName }) => {
    if (globalBlocks[blockerName]) globalBlocks[blockerName] = globalBlocks[blockerName].filter(name => name !== blockedName);
    io.emit('sync_global_blocks', globalBlocks);
  });

  // 🛠️ [ফিক্সড ডিসকানেক্ট হ্যান্ডলার]: ইনস্ট্যান্ট ডিলিট না করে ৫ সেকেন্ড ওয়েট করবে
  socket.on('disconnect', async () => {
    console.log(`❌ User disconnected: ${socket.id}`);
    const disconnectedUser = socket.username;

    if (disconnectedUser && usersCollection) {
      activeUsersDirectory = activeUsersDirectory.filter(u => u.id !== socket.id);
      io.emit('update_directory', activeUsersDirectory);

      if (socket.isGuestUser === true || socket.isGuestUser === 'true') {
        console.log(`⏳ Setting a 5-second timeout before deleting data for guest: ${disconnectedUser}`);
        
        // ৫ সেকেন্ডের টাইমার সেট করা হলো
        disconnectTimeouts[disconnectedUser] = setTimeout(async () => {
          try {
            await usersCollection.deleteOne({ name: disconnectedUser, isGuest: true });
            console.log(`🗑️ গেস্ট ইউজার '${disconnectedUser}' users কালেকশন থেকে ডিলিট হয়েছে।`);

            if (messagesCollection) {
              const deleteResult = await messagesCollection.deleteMany({
                $or: [
                  { senderName: disconnectedUser },
                  { receiverName: disconnectedUser }
                ]
              });
              console.log(`🗑️ '${disconnectedUser}' এর চ্যাট হিস্ট্রি সম্পূর্ণ ক্লিয়ার! মোট মুছে ফেলা মেসেজ: ${deleteResult.deletedCount}`);
            }
            delete disconnectTimeouts[disconnectedUser];
          } catch (dbErr) {
            console.error("❌ টাইমাউটে ডাটা ক্লিয়ার এরর:", dbErr.message);
          }
        }, 5000); // ৫০০০ মিলি-সেকেন্ড = ৫ সেকেন্ড
      } else {
        console.log(`🔒 গুগল ইউজার '${disconnectedUser}' ডিসকানেক্ট হয়েছে (ডাটা সেভড)।`);
      }
    }
  });
});

// ------------------- SERVER BOOTUP -------------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Chat Channel Backend Server is running fine on port ${PORT}`);
});