import nodemailer from "nodemailer";

export function buildSmtpTransport(params) {
  const { host, port, user, password } = params;
  const p = Number(port);
  const secure = p === 465;
  return nodemailer.createTransport({
    host: String(host),
    port: Number.isFinite(p) ? p : 587,
    secure,
    auth: user ? { user: String(user), pass: String(password) } : undefined,
  });
}

export async function sendEmail(params) {
  const { smtp, from, to, subject, text } = params;
  const transport = buildSmtpTransport(smtp);
  const info = await transport.sendMail({
    from,
    to,
    subject,
    text,
  });
  return info;
}

