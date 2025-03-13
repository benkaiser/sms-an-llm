require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const https = require("https");
const fs = require("fs");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;
const SMS_GATEWAY_URL = `http://localhost:8080`;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Load self-signed certificate
const options = {
  key: fs.readFileSync("server.key"),
  cert: fs.readFileSync("server.crt"),
  ca: fs.readFileSync("rootCA.crt"),
};

// Initialize SQLite database
const db = new Database("messages.db");
db.exec(
  "CREATE TABLE IF NOT EXISTS message_history (id INTEGER PRIMARY KEY, phoneNumber TEXT, message TEXT, response TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)"
);

// Middleware
app.use(bodyParser.json());

// Deregister existing webhooks
async function deregisterWebhooks() {
  try {
    const response = await axios.get(`${SMS_GATEWAY_URL}/webhooks`, {
      auth: {
        username: process.env.SMS_USERNAME,
        password: process.env.SMS_PASSWORD,
      },
    });

    for (const webhook of response.data) {
      await axios.delete(`${SMS_GATEWAY_URL}/webhooks/${webhook.id}`, {
        auth: {
          username: process.env.SMS_USERNAME,
          password: process.env.SMS_PASSWORD,
        },
      });
      console.log(`Deregistered webhook: ${webhook.id}`);
    }
  } catch (error) {
    console.error("Failed to deregister webhooks:", error.response?.data || error.message);
  }
}

// Register webhook on startup
async function registerWebhook() {
  try {
    await axios.post(
      `${SMS_GATEWAY_URL}/webhooks`,
      {
        url: WEBHOOK_URL,
        event: "sms:received",
      },
      {
        auth: {
          username: process.env.SMS_USERNAME,
          password: process.env.SMS_PASSWORD,
        },
      }
    );
    console.log("Webhook registered successfully!");
  } catch (error) {
    console.error("Failed to register webhook:", error.response?.data || error.message);
  }
}

// Webhook endpoint
app.post("/webhook", async (req, res) => {
  console.log("Received SMS:", req.body);

  const { message, phoneNumber } = req.body.payload;
  if (!message || !phoneNumber) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // Check for reset command
  if (["CLEAR", "RESET", "NEW"].includes(message.trim().toUpperCase())) {
    db.prepare("DELETE FROM message_history WHERE phoneNumber = ?").run(phoneNumber);
    console.log("Cleared conversation history for", phoneNumber);
    
    await axios.post(
      `${SMS_GATEWAY_URL}/message`,
      {
        message: "Conversation history cleared.",
        phoneNumbers: [phoneNumber],
      },
      {
        auth: {
          username: process.env.SMS_USERNAME,
          password: process.env.SMS_PASSWORD,
        },
      }
    );

    return res.json({ success: true, reply: "Conversation history cleared." });
  }

  try {
    // Retrieve message history
    const rows = db.prepare("SELECT message, response FROM message_history WHERE phoneNumber = ? ORDER BY timestamp ASC").all(phoneNumber);

	  const conversationHistory = [
  { role: "system", content: "Keep responses short and concise for SMS readability." },
  ...rows.flatMap(row => [
    { role: "user", content: row.message },
    { role: "assistant", content: row.response }
  ]),
  { role: "user", content: message }
];
    
    const llmResponse = await axios.post(
      "https://api.deepinfra.com/v1/openai/chat/completions",
      {
        model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
        messages: conversationHistory,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.DEEPINFRA_TOKEN}`,
        },
      }
    );

    const replyMessage = llmResponse.data.choices[0].message.content;
    console.log("LLM Response:", replyMessage);

    // Store in database
    db.prepare("INSERT INTO message_history (phoneNumber, message, response) VALUES (?, ?, ?)").run(phoneNumber, message, replyMessage);

    // Send response back via SMS Gateway
    await axios.post(
      `${SMS_GATEWAY_URL}/message`,
      {
        message: replyMessage,
        phoneNumbers: [phoneNumber],
      },
      {
        auth: {
          username: process.env.SMS_USERNAME,
          password: process.env.SMS_PASSWORD,
        },
      }
    );

    console.log("Sent SMS reply to:", phoneNumber);
    res.json({ success: true, reply: replyMessage });
  } catch (error) {
    console.error("Error processing LLM response or sending SMS:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to process response" });
  }
});

// Test page to verify HTTPS setup
app.get("/test", (req, res) => {
  res.send("HTTPS is working correctly!");
});

// Start HTTPS server
https.createServer(options, app).listen(PORT, async () => {
  console.log(`Server running on https://localhost:${PORT}`);
  await deregisterWebhooks();
  await registerWebhook();
});

