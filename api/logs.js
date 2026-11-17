import fs from "fs";
import path from "path";

export default function handler(req, res) {
  const secret = req.query.secret;
  if (!secret || !process.env.LOG_SECRET || secret !== process.env.LOG_SECRET) {
    res.status(403).send("Forbidden");
    return;
  }

  const logFilePath = path.join(process.cwd(), "download-logs.json");
  const tokenFilePath = path.join(process.cwd(), "tokens.json");

  // Load logs
  let logs = [];
  if (fs.existsSync(logFilePath)) {
    const fileData = fs.readFileSync(logFilePath, "utf8");
    logs = fileData ? JSON.parse(fileData) : [];
  }

  // Load current tokens to determine status
  let usedTokens = {};
  if (fs.existsSync(tokenFilePath)) {
    const fileData = fs.readFileSync(tokenFilePath, "utf8");
    usedTokens = fileData ? JSON.parse(fileData) : {};
  }

  const now = Date.now();
  const expiration = 24 * 60 * 60 * 1000; // 24 hours

  // Enhance logs with token status
  const enhancedLogs = logs.map(entry => {
    const tokenTime = usedTokens[entry.token];
    let tokenStatus = "expired"; // default

    if (tokenTime) {
      const tokenAge = now - new Date(tokenTime).getTime();
      tokenStatus = tokenAge <= expiration ? "valid" : "expired";
    } else if (entry.status === "blocked") {
      tokenStatus = "blocked";
    } else {
      tokenStatus = "used";
    }

    return { ...entry, tokenStatus };
  });

  res.status(200).json(enhancedLogs);
}
