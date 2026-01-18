const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../utils/logger');

// Create transporter - lazily initialized
let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;

  // For development without SMTP, simulate emails
  if (process.env.NODE_ENV !== 'production' && !process.env.SMTP_HOST) {
    transporter = {
      sendMail: async (options) => {
        logger.info('📧 Email simulé (dev mode):');
        logger.info(`   To: ${options.to}`);
        logger.info(`   Subject: ${options.subject}`);
        logger.info(`   Preview: ${options.text?.substring(0, 100)}...`);
        return { messageId: 'dev-mode-' + Date.now() };
      },
      verify: async () => true
    };
    return transporter;
  }

  const smtpConfig = {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD || process.env.SMTP_PASS,
    },
    // Gmail specific settings
    tls: {
      rejectUnauthorized: false
    },
    // Debug settings
    debug: process.env.NODE_ENV !== 'production',
    logger: process.env.NODE_ENV !== 'production'
  };

  logger.info('📧 Creating SMTP transporter with config:', {
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    user: smtpConfig.auth.user,
    passLength: smtpConfig.auth.pass?.length || 0
  });

  transporter = nodemailer.createTransport(smtpConfig);
  return transporter;
};

// Verify SMTP connection
const verifyConnection = async () => {
  try {
    const t = getTransporter();
    if (t.verify) {
      await t.verify();
      logger.info('✅ SMTP connection verified successfully');
      return true;
    }
    return true;
  } catch (error) {
    logger.error('❌ SMTP connection verification failed:', error.message);
    return false;
  }
};

// Email templates
const templates = {
  invitation: (data) => ({
    subject: `Invitation à rejoindre ${data.workspaceName} sur GesProjet`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', Arial, sans-serif; background-color: #f5f5f5; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background: #1a1a2e; border-radius: 12px; overflow: hidden; }
          .header { background: linear-gradient(135deg, #6366f1, #8b5cf6); padding: 30px; text-align: center; }
          .header h1 { color: white; margin: 0; font-size: 24px; }
          .content { padding: 30px; color: #e0e0e0; }
          .content h2 { color: #fff; margin-top: 0; }
          .credentials { background: #252541; border-radius: 8px; padding: 20px; margin: 20px 0; }
          .credentials p { margin: 8px 0; }
          .credentials strong { color: #8b5cf6; }
          .btn { display: inline-block; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 20px; }
          .warning { background: #f59e0b20; border-left: 4px solid #f59e0b; padding: 12px; margin-top: 20px; border-radius: 4px; }
          .footer { padding: 20px; text-align: center; color: #888; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🚀 BIS-GesProjet</h1>
          </div>
          <div class="content">
            <h2>Bienvenue !</h2>
            <p>Vous avez été invité(e) par <strong>${data.inviterName}</strong> à rejoindre l'espace de travail <strong>${data.workspaceName}</strong>.</p>
            
            <div class="credentials">
              <p>📧 <strong>Email:</strong> ${data.email}</p>
              <p>🔑 <strong>Mot de passe temporaire:</strong> ${data.tempPassword}</p>
            </div>
            
            <p>Cliquez sur le bouton ci-dessous pour vous connecter:</p>
            <a href="${data.loginUrl}" class="btn">Se connecter →</a>
            
            <div class="warning">
              ⚠️ <strong>Important:</strong> Vous devrez changer votre mot de passe lors de votre première connexion.
            </div>
          </div>
          <div class="footer">
            <p>BIS-GesProjet - Gestion de projets collaborative</p>
            <p>Cet email a été envoyé automatiquement, merci de ne pas y répondre.</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
Bienvenue sur BIS-GesProjet !

Vous avez été invité(e) par ${data.inviterName} à rejoindre l'espace de travail "${data.workspaceName}".

Vos identifiants de connexion:
- Email: ${data.email}
- Mot de passe temporaire: ${data.tempPassword}

Connectez-vous ici: ${data.loginUrl}

IMPORTANT: Vous devrez changer votre mot de passe lors de votre première connexion.
    `
  }),

  passwordReset: (data) => ({
    subject: 'Réinitialisation de votre mot de passe - Time Tracker',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', Arial, sans-serif; background-color: #f5f5f5; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background: #1a1a2e; border-radius: 12px; overflow: hidden; }
          .header { background: linear-gradient(135deg, #6366f1, #8b5cf6); padding: 30px; text-align: center; }
          .header h1 { color: white; margin: 0; font-size: 24px; }
          .content { padding: 30px; color: #e0e0e0; }
          .btn { display: inline-block; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 20px; }
          .footer { padding: 20px; text-align: center; color: #888; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔑 Réinitialisation du mot de passe</h1>
          </div>
          <div class="content">
            <p>Bonjour ${data.firstName},</p>
            <p>Cliquez sur le bouton ci-dessous pour réinitialiser votre mot de passe:</p>
            <a href="${data.resetUrl}" class="btn">Réinitialiser le mot de passe</a>
            <p style="margin-top: 20px; color: #888;">Ce lien expire dans 1 heure.</p>
          </div>
          <div class="footer">
            <p>Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `Réinitialisation de votre mot de passe\n\nBonjour ${data.firstName},\n\nCliquez sur ce lien pour réinitialiser votre mot de passe: ${data.resetUrl}\n\nCe lien expire dans 1 heure.`
  })
};

// Parse EMAIL_FROM which can be in format: "Name" <email> or just email
const getFromAddress = () => {
  const emailFrom = process.env.EMAIL_FROM;
  const smtpUser = process.env.SMTP_USER;
  
  if (emailFrom) {
    // If EMAIL_FROM contains both name and email, clean it up
    // Remove extra quotes that might be in env var
    const cleaned = emailFrom.replace(/^["']|["']$/g, '').trim();
    
    // Check if it's in format: "Name" <email> or Name <email>
    if (cleaned.includes('<') && cleaned.includes('>')) {
      return cleaned;
    }
    
    // If it's just a name, add the SMTP user as email
    if (smtpUser) {
      return `"${cleaned}" <${smtpUser}>`;
    }
    
    return cleaned;
  }
  
  // Default fallback
  if (smtpUser) {
    return `"GesProjet" <${smtpUser}>`;
  }
  
  return '"GesProjet" <noreply@gesprojet.tech>';
};

// Send email function
const sendEmail = async (to, templateName, data) => {
  try {
    const template = templates[templateName];
    if (!template) {
      throw new Error(`Template "${templateName}" not found`);
    }

    const emailContent = template(data);
    const fromAddress = getFromAddress();
    
    logger.info(`📧 Preparing email to ${to}`);
    logger.info(`   From: ${fromAddress}`);
    logger.info(`   Subject: ${emailContent.subject}`);
    logger.info(`   SMTP: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT}`);
    logger.info(`   User: ${process.env.SMTP_USER}`);
    
    const t = getTransporter();
    
    const info = await t.sendMail({
      from: fromAddress,
      to,
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html,
    });

    logger.info(`✅ Email sent successfully!`);
    logger.info(`   MessageId: ${info.messageId}`);
    logger.info(`   Response: ${info.response}`);
    
    return { success: true, messageId: info.messageId };
  } catch (error) {
    logger.error('❌ Send email error:', error.message);
    logger.error('   Error code:', error.code);
    logger.error('   Error command:', error.command);
    if (error.response) {
      logger.error('   SMTP Response:', error.response);
    }
    throw error;
  }
};

// Test email function for debugging
const testEmailConnection = async () => {
  try {
    logger.info('🔧 Testing email configuration...');
    await verifyConnection();
    
    logger.info('📧 Email config:', {
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      user: process.env.SMTP_USER,
      from: getFromAddress()
    });
    
    return { success: true, from: getFromAddress() };
  } catch (error) {
    logger.error('❌ Email test failed:', error.message);
    return { success: false, error: error.message };
  }
};

module.exports = {
  sendEmail,
  templates,
  verifyConnection,
  testEmailConnection
};
