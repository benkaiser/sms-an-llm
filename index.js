require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const https = require("https");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const SMS_GATEWAY_URL = `http://localhost:8080`;
const WEBHOOK_ID = "sms-received-hook";
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Load self-signed certificate
const options = {
  key: fs.readFileSync("server.key"),
  cert: fs.readFileSync("server.crt"),
  ca: fs.readFileSync("rootCA.crt"),
};

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

  try {
    const llmResponse = await axios.post(
      "https://api.deepinfra.com/v1/openai/chat/completions",
      {
        model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
        messages: [{ role: "user", content: message }],
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

