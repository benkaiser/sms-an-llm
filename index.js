require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const fs = require("fs");
const Database = require("better-sqlite3");
const llama3Tokenizer = require("llama3-tokenizer-js");

const app = express();
const PORT = process.env.PORT || 3000;
const SMS_GATEWAY_URL = `http://127.0.0.1:8080`;
const WEBHOOK_URL = `http://127.0.0.1:${PORT}/webhook`;

const TOKEN_LIMIT = 4000;

const ALLOWED_COUNTRY_CODES = [
  "+61",  // Australia
  "+55",  // Brazil
  "+1",   // Canada, USA
  "+86",  // China
  "+33",  // France
  "+49",  // Germany
  "+852", // Hong Kong
  "+91",  // India
  "+62",  // Indonesia
  "+353", // Ireland
  "+972", // Israel
  "+81",  // Japan
  "+60",  // Malaysia
  "+52",  // Mexico
  "+64",  // New Zealand
  "+47",  // Norway
  "+65",  // Singapore
  "+82",  // South Korea
  "+66",  // Thailand
  "+44"   // UK
];

// Initialize SQLite database
const db = new Database("messages.db");
db.exec(
  "CREATE TABLE IF NOT EXISTS message_history (id INTEGER PRIMARY KEY, phoneNumber TEXT, message TEXT, response TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)"
);

// Middleware
app.use(bodyParser.json());

// Function to deregister existing webhooks
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

// Function to register webhook
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

// Function to trim conversation to token limit
function trimConversationToTokenLimit(conversation) {
  while (llama3Tokenizer.default.encode(JSON.stringify(conversation)).length > TOKEN_LIMIT) {
    if (conversation.length <= 2) {
      return [];
    }
    conversation.splice(1, 2); // Remove oldest user + assistant pair
  }
  return conversation;
}

// Webhook endpoint
app.post("/webhook", async (req, res) => {
  console.log("Received SMS:", req.body);

  const { message, phoneNumber } = req.body.payload;
  if (!message || !phoneNumber) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  if (!ALLOWED_COUNTRY_CODES.some(code => phoneNumber.startsWith(code))) {
    console.log("Blocked SMS from unauthorized country code:", phoneNumber);
    return res.status(403).json({ error: "Unauthorized country code" });
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

    let conversationHistory = [
      { role: "system", content: "Keep responses short and concise for SMS readability." },
      ...rows.flatMap(row => [
        { role: "user", content: row.message },
        { role: "assistant", content: row.response }
      ]),
      { role: "user", content: message }
    ];

    conversationHistory = trimConversationToTokenLimit(conversationHistory);

    if (conversationHistory.length === 0) {
      await axios.post(
        `${SMS_GATEWAY_URL}/message`,
        {
          message: "Messages must be less than 4000 tokens.",
          phoneNumbers: [phoneNumber],
        },
        {
          auth: {
            username: process.env.SMS_USERNAME,
            password: process.env.SMS_PASSWORD,
          },
        }
      );
      return res.json({ success: true, reply: "Messages must be less than 4000 tokens." });
    }

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

// Test page to verify HTTP setup
app.get("/test", (req, res) => {
  res.send("HTTP is working correctly!");
});

// Start HTTP server
app.listen(PORT, async () => {
  console.log(`Server running on http://127.0.0.1:${PORT}`);
  await deregisterWebhooks();
  await registerWebhook();
});
