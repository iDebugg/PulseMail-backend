require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "pulsemail-dev-secret-change-in-production";

// ─── Middleware ───
app.use(cors({ origin: "http://localhost:5173", credentials: true }));
app.use(express.json({ limit: "10mb" }));

// ─── Database Setup ───
const db = new Database(path.join(__dirname, "pulsemail.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT DEFAULT '',
    email TEXT NOT NULL,
    group_tag TEXT DEFAULT 'Newsletter',
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'Newsletter',
    status TEXT DEFAULT 'Draft',
    subject TEXT DEFAULT '',
    body TEXT DEFAULT '',
    cta TEXT DEFAULT '',
    sender_name TEXT DEFAULT '',
    from_email TEXT DEFAULT '',
    brand_color TEXT DEFAULT '#008CFF',
    sent_count INTEGER DEFAULT 0,
    open_count INTEGER DEFAULT 0,
    click_count INTEGER DEFAULT 0,
    scheduled_at DATETIME,
    sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sent_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    campaign_id INTEGER,
    to_email TEXT NOT NULL,
    cc TEXT DEFAULT '',
    bcc TEXT DEFAULT '',
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    sender_name TEXT DEFAULT '',
    from_email TEXT DEFAULT '',
    status TEXT DEFAULT 'sent',
    error_message TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
  );
`);

// ─── Resend API Key ───
const RESEND_API_KEY = process.env.RESEND_API_KEY || process.env.SMTP_PASS || "";

async function sendViaResend({ from, to, cc, bcc, subject, html }) {
  const payload = { from, to: Array.isArray(to) ? to : [to], subject, html };
  if (cc) payload.cc = Array.isArray(cc) ? cc : [cc];
  if (bcc) payload.bcc = Array.isArray(bcc) ? bcc : [bcc];

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.message || JSON.stringify(data));
  return data;
}

if (RESEND_API_KEY && RESEND_API_KEY.startsWith("re_")) {
  console.log("✅ Resend API key configured — real emails will be sent via HTTP API\n");
} else {
  console.log("⚠️  No Resend API key found. Email sending will be simulated.");
  console.log("   Set RESEND_API_KEY in your environment variables.\n");
}

// ─── Auth Middleware ───
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }
  try {
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    req.userEmail = decoded.email;
    req.userName = decoded.name;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ─── Build HTML Email ───
function buildEmailHTML({ senderName, subject, body, cta, brandColor, firstName, support }) {
  const color = brandColor || "#008CFF";
  const name = firstName || "there";
  const lines = body.split("\n").filter(Boolean);

  let bodyHTML = "";
  for (const line of lines) {
    const trimmed = line.trim();
    const stepMatch = trimmed.match(/^(\d+)[\.\)]\s*(.*)/);
    const bulletMatch = trimmed.match(/^[•\-]\s*(.*)/);

    if (stepMatch) {
      bodyHTML += `
        <tr><td style="padding:4px 0">
          <table><tr>
            <td style="width:28px;height:28px;background:${color};color:#fff;font-size:13px;font-weight:700;text-align:center;border-radius:50%;vertical-align:top">${stepMatch[1]}</td>
            <td style="padding-left:10px;font-size:15px;color:#374151;line-height:1.6">${stepMatch[2]}</td>
          </tr></table>
        </td></tr>`;
    } else if (bulletMatch) {
      bodyHTML += `<tr><td style="padding:3px 0 3px 8px;font-size:15px;color:#374151;line-height:1.6">• ${bulletMatch[1]}</td></tr>`;
    } else {
      bodyHTML += `<tr><td style="padding:8px 0;font-size:15px;color:#374151;line-height:1.7">${trimmed}</td></tr>`;
    }
  }

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
        <!-- Banner -->
        <tr><td style="background:${color};padding:28px 32px">
          <div style="font-size:22px;font-weight:700;color:#ffffff">${senderName} <span style="font-weight:400;font-style:italic">Support</span></div>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px">
          <div style="font-size:20px;font-weight:700;color:#111827;margin-bottom:16px;line-height:1.3">${subject}</div>
          <p style="font-size:15px;color:#374151;margin:0 0 12px">Hi ${name},</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            ${bodyHTML}
          </table>
          <!-- CTA -->
          ${cta ? `
          <table cellpadding="0" cellspacing="0" style="margin:28px 0">
            <tr><td style="background:${color};border-radius:8px;padding:14px 36px">
              <a href="#" style="color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:0.02em">${cta}</a>
            </td></tr>
          </table>` : ""}
          <!-- Footer -->
          <div style="border-top:1px solid #e5e7eb;padding-top:20px;margin-top:24px;font-size:12px;color:#9ca3af;line-height:1.6">
            This email was sent by <strong style="color:#6b7280">${senderName}</strong>. If you believe you received this in error, please contact our support team.
          </div>
          ${support && support.trim() ? `
          <!-- Support Contact -->
          <table cellpadding="0" cellspacing="0" width="100%" style="margin-top:16px">
            <tr><td style="background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;padding:14px 16px">
              <table cellpadding="0" cellspacing="0"><tr>
                <td style="width:36px;height:36px;background:#f3f4f6;border-radius:50%;text-align:center;vertical-align:middle">
                  <img src="https://img.icons8.com/ios-filled/24/6b7280/phone.png" alt="phone" width="16" height="16" style="vertical-align:middle"/>
                </td>
                <td style="padding-left:12px">
                  <div style="font-size:12px;font-weight:600;color:#374151">Get in touch with ${senderName}. Available 24/7.</div>
                  <div style="font-size:13px;font-weight:600;color:${color};margin-top:2px">${support}</div>
                </td>
              </tr></table>
            </td></tr>
          </table>` : ""}
        </td></tr>
      </table>
      <!-- Copyright & Unsubscribe -->
      <p style="font-size:11px;color:#c0c4cc;margin-top:16px;text-align:center">
        &copy; ${new Date().getFullYear()} ${senderName} &middot; <a href="#" style="color:#c0c4cc;text-decoration:underline">Unsubscribe</a> &middot; <a href="#" style="color:#c0c4cc;text-decoration:underline">Privacy Policy</a>
      </p>
    </td></tr>
  </table>
</body>
</html>`;
}


// ════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════

// ─── Register ───
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    if (!email.includes("@")) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    // Check if user exists
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    // Hash password and create user
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare("INSERT INTO users (name, email, password) VALUES (?, ?, ?)").run(name, email.toLowerCase(), hash);

    const token = jwt.sign({ id: result.lastInsertRowid, email: email.toLowerCase(), name }, JWT_SECRET, { expiresIn: "7d" });

    console.log(`✅ New user registered: ${email}`);

    res.status(201).json({
      token,
      user: { id: result.lastInsertRowid, name, email: email.toLowerCase() },
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Server error during registration" });
  }
});

// ─── Login ───
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "7d" });

    console.log(`✅ User logged in: ${email}`);

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error during login" });
  }
});

// ─── Get current user ───
app.get("/api/auth/me", auth, (req, res) => {
  const user = db.prepare("SELECT id, name, email, created_at FROM users WHERE id = ?").get(req.userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user });
});


// ════════════════════════════════════════════
// EMAIL ROUTES
// ════════════════════════════════════════════

// ─── Send Email ───
app.post("/api/email/send", auth, async (req, res) => {
  try {
    const { to, cc, bcc, subject, body, senderName, fromEmail, cta, brandColor, firstName, support } = req.body;

    if (!to || !subject || !body) {
      return res.status(400).json({ error: "Recipient, subject, and body are required" });
    }

    const recipients = to.split(",").map(e => e.trim()).filter(Boolean);
    if (recipients.length === 0) {
      return res.status(400).json({ error: "At least one valid recipient is required" });
    }

    const resolvedSubject = subject
      .replace("{{brand}}", senderName || req.userName)
      .replace("{{month}}", new Date().toLocaleString("default", { month: "long" }));

    const html = buildEmailHTML({
      senderName: senderName || req.userName,
      subject: resolvedSubject,
      body,
      cta,
      brandColor,
      firstName,
      support,
    });

    let status = "sent";
    let errorMessage = null;

    if (RESEND_API_KEY && RESEND_API_KEY.startsWith("re_")) {
      try {
        const result = await sendViaResend({
          from: `${senderName || req.userName} <${fromEmail || "hello@supportpulsemail.online"}>`,
          to: recipients,
          cc: cc || undefined,
          bcc: bcc || undefined,
          subject: resolvedSubject,
          html,
        });
        console.log(`📧 Email sent to ${to} — ID: ${result.id}`);
      } catch (mailErr) {
        status = "failed";
        errorMessage = mailErr.message;
        console.error(`❌ Email failed to ${to}:`, mailErr.message);
      }
    } else {
      console.log(`📧 [SIMULATED] Email to ${to} — Subject: "${subject}"`);
      status = "simulated";
    }

    // Log to database
    const insertEmail = db.prepare(`
      INSERT INTO sent_emails (user_id, to_email, cc, bcc, subject, body, sender_name, from_email, status, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const recipient of recipients) {
      insertEmail.run(req.userId, recipient, cc || "", bcc || "", resolvedSubject, body, senderName || req.userName, fromEmail || req.userEmail, status, errorMessage);
    }

    if (status === "failed") {
      return res.status(500).json({ error: `Email failed: ${errorMessage}` });
    }

    res.json({
      success: true,
      status,
      message: status === "simulated"
        ? `Email simulated (no API key). ${recipients.length} recipient(s) logged.`
        : `Email sent to ${recipients.length} recipient(s) successfully!`,
      recipients: recipients.length,
    });
  } catch (err) {
    console.error("Send email error:", err);
    res.status(500).json({ error: "Failed to send email" });
  }
});

// ─── Get sent email history ───
app.get("/api/email/history", auth, (req, res) => {
  const emails = db.prepare(`
    SELECT id, to_email, subject, sender_name, from_email, status, error_message, sent_at
    FROM sent_emails WHERE user_id = ? ORDER BY sent_at DESC LIMIT 50
  `).all(req.userId);
  res.json({ emails });
});


// ════════════════════════════════════════════
// CONTACTS ROUTES
// ════════════════════════════════════════════

app.get("/api/contacts", auth, (req, res) => {
  const contacts = db.prepare("SELECT * FROM contacts WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
  res.json({ contacts });
});

app.post("/api/contacts", auth, (req, res) => {
  const { first_name, last_name, email, group_tag, notes } = req.body;
  if (!first_name || !email) {
    return res.status(400).json({ error: "First name and email are required" });
  }
  const result = db.prepare(
    "INSERT INTO contacts (user_id, first_name, last_name, email, group_tag, notes) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(req.userId, first_name, last_name || "", email, group_tag || "Newsletter", notes || "");

  const contact = db.prepare("SELECT * FROM contacts WHERE id = ?").get(result.lastInsertRowid);
  console.log(`👤 Contact added: ${first_name} ${last_name} <${email}>`);
  res.status(201).json({ contact });
});

app.delete("/api/contacts/:id", auth, (req, res) => {
  const result = db.prepare("DELETE FROM contacts WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  if (result.changes === 0) return res.status(404).json({ error: "Contact not found" });
  res.json({ success: true });
});


// ════════════════════════════════════════════
// CAMPAIGNS ROUTES
// ════════════════════════════════════════════

app.get("/api/campaigns", auth, (req, res) => {
  const campaigns = db.prepare("SELECT * FROM campaigns WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
  res.json({ campaigns });
});

app.post("/api/campaigns", auth, (req, res) => {
  const { name, type, subject, body, cta, sender_name, from_email, brand_color, status } = req.body;
  if (!name) return res.status(400).json({ error: "Campaign name is required" });

  const result = db.prepare(`
    INSERT INTO campaigns (user_id, name, type, subject, body, cta, sender_name, from_email, brand_color, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.userId, name, type || "Newsletter", subject || "", body || "", cta || "", sender_name || "", from_email || "", brand_color || "#008CFF", status || "Draft");

  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json({ campaign });
});


// ════════════════════════════════════════════
// DASHBOARD STATS
// ════════════════════════════════════════════

app.get("/api/dashboard", auth, (req, res) => {
  const totalSent = db.prepare("SELECT COUNT(*) as count FROM sent_emails WHERE user_id = ?").get(req.userId).count;
  const totalContacts = db.prepare("SELECT COUNT(*) as count FROM contacts WHERE user_id = ?").get(req.userId).count;
  const totalCampaigns = db.prepare("SELECT COUNT(*) as count FROM campaigns WHERE user_id = ?").get(req.userId).count;
  const recentEmails = db.prepare("SELECT * FROM sent_emails WHERE user_id = ? ORDER BY sent_at DESC LIMIT 5").all(req.userId);

  res.json({
    stats: {
      emailsSent: totalSent,
      contacts: totalContacts,
      campaigns: totalCampaigns,
    },
    recentEmails,
  });
});


// ─── Start Server ───
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║         🚀 PulseMail Server              ║
  ║         Running on port ${PORT}              ║
  ╚═══════════════════════════════════════════╝
  `);
});