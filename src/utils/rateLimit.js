const attempts = {};

export const limitLoginAttempts = (req, res, next) => {
  const ip = req.ip;
  const now = Date.now();

  if (attempts[ip] && now - attempts[ip] < 5000) {
    const timeLeft = 5000 - (now - attempts[ip]);
    return res.status(429).json({
      error: `Too many attempts. Wait ${Math.ceil(timeLeft / 1000)} seconds.`,
    });
  }

  attempts[ip] = now;
  next();
};
