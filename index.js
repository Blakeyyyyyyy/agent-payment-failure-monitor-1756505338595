const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const Airtable = require('airtable');
const crypto = require('crypto');

const app = express();
app.use(express.raw({ type: 'application/json' }));
app.use(express.json());

// Initialize Airtable - Growth AI base
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base('appUNIsu8KgvOlmi0');

// Gmail setup
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// Simple logging
let logs = [];
function log(message) {
  const entry = { time: new Date().toISOString(), message };
  logs.push(entry);
  if (logs.length > 100) logs = logs.slice(-100);
  console.log(`${entry.time}: ${message}`);
}

// Send email alert
async function sendAlert(paymentData) {
  const mailOptions = {
    from: process.env.GMAIL_USER,
    to: process.env.ALERT_EMAIL || process.env.GMAIL_USER,
    subject: `🚨 Payment Failed - ${paymentData.email}`,
    html: `
      <h2>Payment Failure Alert</h2>
      <p><strong>Customer:</strong> ${paymentData.email}</p>
      <p><strong>Amount:</strong> $${(paymentData.amount / 100).toFixed(2)}</p>
      <p><strong>Reason:</strong> ${paymentData.reason}</p>
      <p><strong>Charge ID:</strong> ${paymentData.chargeId}</p>
      <p><strong>Date:</strong> ${new Date(paymentData.date).toLocaleString()}</p>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    log(`Email sent for charge ${paymentData.chargeId}`);
    return true;
  } catch (error) {
    log(`Email failed: ${error.message}`);
    return false;
  }
}

// Add to Airtable
async function addToTable(paymentData) {
  try {
    const record = await base('Failed Payments').create([{
      fields: {
        'Customer Email': paymentData.email,
        'Customer ID': paymentData.customerId,
        'Payment Amount': paymentData.amount / 100,
        'Payment Method': paymentData.method,
        'Failure Reason': paymentData.reason,
        'Failure Date': new Date(paymentData.date).toISOString(),
        'Charge ID': paymentData.chargeId,
        'Status': 'Failed'
      }
    }]);
    
    log(`Added to Airtable: ${record[0].id}`);
    return true;
  } catch (error) {
    log(`Airtable error: ${error.message}`);
    return false;
  }
}

// Process failed payment
async function handleFailure(charge) {
  const data = {
    email: charge.billing_details?.email || 'Unknown',
    customerId: charge.customer || 'Unknown',
    amount: charge.amount,
    method: charge.payment_method_details?.type || 'Unknown',
    reason: charge.failure_message || 'Unknown',
    chargeId: charge.id,
    date: charge.created * 1000
  };

  log(`Processing failed payment: ${data.chargeId}`);
  
  await sendAlert(data);
  await addToTable(data);
}

// Routes
app.get('/', (req, res) => {
  res.json({
    name: 'Payment Failure Monitor',
    status: 'running',
    endpoints: ['/', '/health', '/logs', '/test', '/webhook']
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', time: new Date().toISOString() });
});

app.get('/logs', (req, res) => {
  res.json({ logs: logs.slice(-20) });
});

app.post('/test', async (req, res) => {
  log('Test triggered');
  
  const testData = {
    email: 'test@example.com',
    customerId: 'test_customer',
    amount: 2000,
    method: 'card',
    reason: 'Test failure',
    chargeId: 'test_charge',
    date: Date.now()
  };
  
  const emailSent = await sendAlert(testData);
  
  res.json({
    message: 'Test complete',
    emailSent,
    time: new Date().toISOString()
  });
});

app.post('/webhook', async (req, res) => {
  let event;
  try {
    event = JSON.parse(req.body);
  } catch (err) {
    log('Invalid JSON in webhook');
    return res.status(400).send('Invalid JSON');
  }

  log(`Webhook received: ${event.type}`);

  switch (event.type) {
    case 'charge.failed':
      await handleFailure(event.data.object);
      break;
    case 'payment_intent.payment_failed':
      if (event.data.object.charges?.data?.length > 0) {
        await handleFailure(event.data.object.charges.data[0]);
      }
      break;
    case 'invoice.payment_failed':
      if (event.data.object.charge) {
        try {
          const charge = await stripe.charges.retrieve(event.data.object.charge);
          await handleFailure(charge);
        } catch (error) {
          log(`Failed to get charge: ${error.message}`);
        }
      }
      break;
    default:
      log(`Unhandled event: ${event.type}`);
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Payment failure monitor started on port ${PORT}`);
});