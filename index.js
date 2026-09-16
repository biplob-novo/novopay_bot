/**
 * ============================================================
 *  NOVOPAY WHATSAPP BOT  –  index.js
 *  Fintech Services Assistant via WhatsApp
 * ============================================================
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode-terminal');
const pino   = require('pino');

// ── Secure config from GitHub Secrets ──────────────────────
const FIREBASE_URL = process.env.FIREBASE_URL;

// ── In-memory session state per user ───────────────────────
const sessions = {};

// ── Novopay colour codes (for log formatting) ──────────────
const C = { reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', bold: '\x1b[1m' };
const log = (msg, color = C.cyan) => console.log(`${color}${C.bold}[NOVOPAY]${C.reset} ${msg}`);

// ── Helper: fetch Firebase REST ────────────────────────────
async function fbGet(path) {
    const res = await fetch(`${FIREBASE_URL}/${path}.json`);
    return res.ok ? res.json() : null;
}

async function fbPost(path, data) {
    const res = await fetch(`${FIREBASE_URL}/${path}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return res.ok ? res.json() : null;
}

async function fbPatch(path, data) {
    await fetch(`${FIREBASE_URL}/${path}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
}

// ── Fetch live services / products from Firebase ───────────
async function getServices() {
    try {
        const data = await fbGet('services');
        if (!data) return [];
        return Object.keys(data).map(key => ({
            id: key,
            name: data[key].name,
            description: data[key].description,
            fee: data[key].fee,
            category: data[key].category || 'General',
            iconEmoji: data[key].iconEmoji || '💳'
        }));
    } catch (err) {
        log('Firebase fetch error: ' + err.message, C.red);
        return [];
    }
}

// ── Fetch wallet / account balance for a user ──────────────
async function getUserWallet(phone) {
    try {
        const data = await fbGet(`wallets/${phone}`);
        return data || null;
    } catch {
        return null;
    }
}

// ── Fetch recent transactions for a user ───────────────────
async function getRecentTransactions(phone) {
    try {
        const data = await fbGet(`transactions/${phone}`);
        if (!data) return [];
        return Object.values(data)
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .slice(0, 5);
    } catch {
        return [];
    }
}

// ── Save a transaction/request to Firebase ─────────────────
async function saveRequest(payload) {
    return fbPost('requests', payload);
}

// ── Format currency ────────────────────────────────────────
const inr = (n) => `₹${parseFloat(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

// ── Timestamp ──────────────────────────────────────────────
const now = () => new Date().toISOString();

// ── Safe message text extractor ────────────────────────────
function extractText(msg) {
    return (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.buttonsResponseMessage?.selectedDisplayText ||
        msg.message?.listResponseMessage?.title ||
        ''
    ).trim();
}

// ═══════════════════════════════════════════════════════════
//  MENU TEMPLATES
// ═══════════════════════════════════════════════════════════

const MSG = {
    welcome: (name = 'there') => `👋 *Welcome to Novopay!*\n\nHello ${name}! I'm your Novopay AI Assistant.\n\nI can help you with:\n💸 *Money Transfers*\n🧾 *Bill Payments*\n📱 *Mobile Recharges*\n🏧 *Wallet Balance*\n📋 *Transaction History*\n🤝 *Become an Agent*\n\nType any keyword above or reply with a number:\n\n1️⃣  Money Transfer\n2️⃣  Bill Payment\n3️⃣  Mobile Recharge\n4️⃣  Check Wallet Balance\n5️⃣  Transaction History\n6️⃣  Become a Novopay Agent\n7️⃣  Help / Contact Support\n\n_Powered by Novopay · India's Trusted Fintech_ 🇮🇳`,

    services: (list) => {
        let msg = '📋 *NOVOPAY LIVE SERVICES*\n\n';
        const cats = {};
        list.forEach(s => {
            if (!cats[s.category]) cats[s.category] = [];
            cats[s.category].push(s);
        });
        Object.entries(cats).forEach(([cat, items]) => {
            msg += `*── ${cat.toUpperCase()} ──*\n`;
            items.forEach(s => {
                msg += `${s.iconEmoji} *${s.name}*`;
                if (s.fee && s.fee > 0) msg += ` · Fee: ${inr(s.fee)}`;
                msg += `\n   ${s.description}\n\n`;
            });
        });
        msg += `_Type *request [service name]* to proceed._\n_Example: *request mobile recharge*_`;
        return msg;
    },

    walletBalance: (wallet, phone) => wallet
        ? `💰 *Novopay Wallet Balance*\n\n📱 Account: *${phone}*\n\n💵 Available Balance: *${inr(wallet.balance)}*\n🔒 Locked Amount: *${inr(wallet.locked || 0)}*\n\n_Last updated: ${new Date(wallet.updatedAt || Date.now()).toLocaleString('en-IN')}_\n\nType *history* to see recent transactions.`
        : `❌ No wallet found for this number.\n\nType *register* to create your Novopay account, or contact support at 1800-419-6626.`,

    txHistory: (txns) => {
        if (!txns.length) return '📋 *Transaction History*\n\nNo recent transactions found.\n\nStart using Novopay services to see your history here!';
        let msg = '📋 *Last 5 Transactions*\n\n';
        txns.forEach((t, i) => {
            const sign = t.type === 'credit' ? '🟢 +' : '🔴 -';
            const date = new Date(t.timestamp).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
            msg += `${i + 1}. ${sign}${inr(t.amount)}\n   ${t.description}\n   _${date}_\n\n`;
        });
        msg += `_For complete statement, visit novopay.com_`;
        return msg;
    },

    transferStart: `💸 *Money Transfer*\n\nPlease reply with the following details in this format:\n\n📝 *Name | Phone | Amount | Bank/UPI*\n\nExample:\n_Rahul Sharma | 9876543210 | 500 | SBI_\n\n⚠️ _Please double-check all details before sending._`,

    billStart: `🧾 *Bill Payment*\n\nPlease reply with the following format:\n\n📝 *Bill Type | Consumer No. | Amount*\n\nSupported: *Electricity, Water, Gas, DTH, Broadband*\n\nExample:\n_Electricity | 1234567890 | 850_`,

    rechargeStart: `📱 *Mobile Recharge*\n\nPlease reply with:\n\n📝 *Mobile Number | Operator | Amount*\n\nExample:\n_9876543210 | Jio | 239_\n\nSupported operators: Jio, Airtel, Vi, BSNL`,

    agentStart: `🤝 *Become a Novopay Agent!*\n\nEarn up to ₹30,000/month as a Novopay Business Correspondent.\n\nPlease share your details:\n\n📝 *Full Name | City | State | Pin Code*\n\nExample:\n_Ramesh Kumar | Lucknow | UP | 226001_`,

    support: `🆘 *Novopay Support*\n\n📞 *Toll Free:* 1800-419-6626 _(24×7)_\n📧 *Email:* support@novopay.com\n🌐 *Website:* www.novopay.com\n\n*Quick Help:*\n• Wallet issues → Type *balance*\n• Recharge failed → Type *recharge*\n• Transfer issues → Type *transfer*\n• Become agent → Type *agent*\n\n_Our support team typically responds within 2 minutes._`,

    confirmTransfer: (name, phone, amt, bank) =>
        `✅ *Transfer Request Received!*\n\n👤 Beneficiary: *${name}*\n📱 Phone/UPI: *${phone}*\n💵 Amount: *${inr(amt)}*\n🏦 Bank/UPI: *${bank}*\n\n🕐 Your request has been queued for processing.\n📋 Reference ID: *NP${Date.now().toString().slice(-8)}*\n\n_Processing time: 2–30 minutes_\n_For instant help: 1800-419-6626_`,

    confirmBill: (type, consumer, amt) =>
        `✅ *Bill Payment Request Received!*\n\n🧾 Bill Type: *${type}*\n🔢 Consumer No: *${consumer}*\n💵 Amount: *${inr(amt)}*\n\n📋 Reference ID: *NP${Date.now().toString().slice(-8)}*\n\n_Your bill will be paid within 5–15 minutes._`,

    confirmRecharge: (mobile, op, amt) =>
        `✅ *Recharge Request Received!*\n\n📱 Mobile: *${mobile}*\n📡 Operator: *${op}*\n💵 Amount: *${inr(amt)}*\n\n📋 Reference ID: *NP${Date.now().toString().slice(-8)}*\n\n_Recharge credited within 2–5 minutes._`,

    confirmAgent: (name, city, state, pin) =>
        `✅ *Agent Registration Received!*\n\n👤 Name: *${name}*\n📍 City: *${city}, ${state} – ${pin}*\n\n🎉 Thank you for your interest!\nOur team will contact you within *24 hours* with the onboarding kit.\n\n📞 Queries: *1800-419-6626*`,

    unknown: `🤔 I didn't understand that.\n\nHere's what I can help you with:\n\n1️⃣  Money Transfer\n2️⃣  Bill Payment\n3️⃣  Mobile Recharge\n4️⃣  Check Wallet Balance\n5️⃣  Transaction History\n6️⃣  Become a Novopay Agent\n7️⃣  Help / Contact Support\n\nOr type *menu* to see full options.`
};

// ═══════════════════════════════════════════════════════════
//  INTENT DETECTOR
// ═══════════════════════════════════════════════════════════
function detectIntent(text) {
    const t = text.toLowerCase();
    if (['hi', 'hello', 'hey', 'start', 'menu', 'help', 'helo', 'hai', 'namaste', '0'].some(k => t === k || t.startsWith(k + ' '))) return 'WELCOME';
    if (['1', 'transfer', 'send money', 'money transfer', 'dmr', 'remittance'].some(k => t === k || t.includes(k))) return 'TRANSFER';
    if (['2', 'bill', 'electricity', 'water', 'gas', 'dth', 'broadband', 'bill payment'].some(k => t === k || t.includes(k))) return 'BILL';
    if (['3', 'recharge', 'mobile recharge', 'top up', 'topup', 'prepaid'].some(k => t === k || t.includes(k))) return 'RECHARGE';
    if (['4', 'balance', 'wallet', 'my balance', 'check balance'].some(k => t === k || t.includes(k))) return 'BALANCE';
    if (['5', 'history', 'transactions', 'statement', 'my transactions'].some(k => t === k || t.includes(k))) return 'HISTORY';
    if (['6', 'agent', 'become agent', 'franchise', 'bc agent', 'business correspondent'].some(k => t === k || t.includes(k))) return 'AGENT';
    if (['7', 'support', 'contact', 'help', 'call', 'helpline'].some(k => t === k || t.includes(k))) return 'SUPPORT';
    if (['services', 'products', 'list', 'what can you do'].some(k => t === k || t.includes(k))) return 'SERVICES';
    return null;
}

// ═══════════════════════════════════════════════════════════
//  CONVERSATION HANDLER
// ═══════════════════════════════════════════════════════════
async function handleMessage(sock, sender, text) {
    const phone = sender.split('@')[0];
    const session = sessions[sender] || {};

    // ── Mid-flow handlers ──────────────────────────────────
    if (session.step) {
        return await handleFlow(sock, sender, phone, text, session);
    }

    // ── Intent routing ─────────────────────────────────────
    const intent = detectIntent(text);
    log(`[${phone}] Intent: ${intent || 'UNKNOWN'} | Text: "${text}"`);

    switch (intent) {
        case 'WELCOME': {
            await sendText(sock, sender, MSG.welcome());
            break;
        }

        case 'TRANSFER': {
            sessions[sender] = { step: 'AWAITING_TRANSFER_DETAILS' };
            await sendText(sock, sender, MSG.transferStart);
            break;
        }

        case 'BILL': {
            sessions[sender] = { step: 'AWAITING_BILL_DETAILS' };
            await sendText(sock, sender, MSG.billStart);
            break;
        }

        case 'RECHARGE': {
            sessions[sender] = { step: 'AWAITING_RECHARGE_DETAILS' };
            await sendText(sock, sender, MSG.rechargeStart);
            break;
        }

        case 'BALANCE': {
            await sendText(sock, sender, '⏳ Fetching your wallet balance...');
            const wallet = await getUserWallet(phone);
            await sendText(sock, sender, MSG.walletBalance(wallet, phone));
            break;
        }

        case 'HISTORY': {
            await sendText(sock, sender, '⏳ Fetching your recent transactions...');
            const txns = await getRecentTransactions(phone);
            await sendText(sock, sender, MSG.txHistory(txns));
            break;
        }

        case 'AGENT': {
            sessions[sender] = { step: 'AWAITING_AGENT_DETAILS' };
            await sendText(sock, sender, MSG.agentStart);
            break;
        }

        case 'SUPPORT': {
            await sendText(sock, sender, MSG.support);
            break;
        }

        case 'SERVICES': {
            await sendText(sock, sender, '⏳ Fetching live services...');
            const services = await getServices();
            if (!services.length) {
                await sendText(sock, sender, 'Our services list is updating. Please try again shortly or type *menu*.');
            } else {
                await sendText(sock, sender, MSG.services(services));
            }
            break;
        }

        default: {
            await sendText(sock, sender, MSG.unknown);
        }
    }
}

// ═══════════════════════════════════════════════════════════
//  FLOW HANDLER (multi-step conversations)
// ═══════════════════════════════════════════════════════════
async function handleFlow(sock, sender, phone, text, session) {
    const step = session.step;

    // ── Cancel any flow ───────────────────────────────────
    if (['cancel', 'exit', 'quit', 'stop', 'menu'].includes(text.toLowerCase())) {
        delete sessions[sender];
        await sendText(sock, sender, '↩️ Request cancelled.\n\nType *menu* to see all options.');
        return;
    }

    // ── TRANSFER FLOW ─────────────────────────────────────
    if (step === 'AWAITING_TRANSFER_DETAILS') {
        const parts = text.split('|').map(p => p.trim());
        if (parts.length < 4) {
            await sendText(sock, sender, `⚠️ Incorrect format. Please use:\n\n*Name | Phone | Amount | Bank*\n\nExample: _Rahul Sharma | 9876543210 | 500 | SBI_\n\nType *cancel* to go back.`);
            return;
        }
        const [name, benefPhone, amt, bank] = parts;
        if (isNaN(amt) || parseFloat(amt) <= 0) {
            await sendText(sock, sender, '⚠️ Invalid amount. Please enter a valid number.');
            return;
        }

        await saveRequest({
            type: 'MONEY_TRANSFER',
            fromPhone: phone,
            beneficiaryName: name,
            beneficiaryPhone: benefPhone,
            amount: parseFloat(amt),
            bank,
            status: 'Pending',
            timestamp: now()
        });

        delete sessions[sender];
        await sendText(sock, sender, MSG.confirmTransfer(name, benefPhone, amt, bank));
        return;
    }

    // ── BILL FLOW ─────────────────────────────────────────
    if (step === 'AWAITING_BILL_DETAILS') {
        const parts = text.split('|').map(p => p.trim());
        if (parts.length < 3) {
            await sendText(sock, sender, `⚠️ Incorrect format. Please use:\n\n*Bill Type | Consumer No. | Amount*\n\nExample: _Electricity | 1234567890 | 850_\n\nType *cancel* to go back.`);
            return;
        }
        const [type, consumer, amt] = parts;
        if (isNaN(amt) || parseFloat(amt) <= 0) {
            await sendText(sock, sender, '⚠️ Invalid amount.');
            return;
        }

        await saveRequest({
            type: 'BILL_PAYMENT',
            fromPhone: phone,
            billType: type,
            consumerNumber: consumer,
            amount: parseFloat(amt),
            status: 'Pending',
            timestamp: now()
        });

        delete sessions[sender];
        await sendText(sock, sender, MSG.confirmBill(type, consumer, amt));
        return;
    }

    // ── RECHARGE FLOW ─────────────────────────────────────
    if (step === 'AWAITING_RECHARGE_DETAILS') {
        const parts = text.split('|').map(p => p.trim());
        if (parts.length < 3) {
            await sendText(sock, sender, `⚠️ Incorrect format. Please use:\n\n*Mobile | Operator | Amount*\n\nExample: _9876543210 | Jio | 239_\n\nType *cancel* to go back.`);
            return;
        }
        const [mobile, operator, amt] = parts;
        if (!/^\d{10}$/.test(mobile)) {
            await sendText(sock, sender, '⚠️ Please enter a valid 10-digit mobile number.');
            return;
        }
        if (isNaN(amt) || parseFloat(amt) <= 0) {
            await sendText(sock, sender, '⚠️ Invalid amount.');
            return;
        }

        await saveRequest({
            type: 'MOBILE_RECHARGE',
            fromPhone: phone,
            rechargeNumber: mobile,
            operator,
            amount: parseFloat(amt),
            status: 'Pending',
            timestamp: now()
        });

        delete sessions[sender];
        await sendText(sock, sender, MSG.confirmRecharge(mobile, operator, amt));
        return;
    }

    // ── AGENT FLOW ────────────────────────────────────────
    if (step === 'AWAITING_AGENT_DETAILS') {
        const parts = text.split('|').map(p => p.trim());
        if (parts.length < 4) {
            await sendText(sock, sender, `⚠️ Incorrect format. Please use:\n\n*Full Name | City | State | Pin Code*\n\nExample: _Ramesh Kumar | Lucknow | UP | 226001_\n\nType *cancel* to go back.`);
            return;
        }
        const [name, city, state, pin] = parts;
        if (!/^\d{6}$/.test(pin)) {
            await sendText(sock, sender, '⚠️ Please enter a valid 6-digit PIN code.');
            return;
        }

        await saveRequest({
            type: 'AGENT_REGISTRATION',
            fromPhone: phone,
            name,
            city,
            state,
            pinCode: pin,
            status: 'New Lead',
            timestamp: now()
        });

        delete sessions[sender];
        await sendText(sock, sender, MSG.confirmAgent(name, city, state, pin));
        return;
    }

    // Fallback
    delete sessions[sender];
    await sendText(sock, sender, MSG.unknown);
}

// ── Utility: send plain text ───────────────────────────────
async function sendText(sock, jid, text) {
    await sock.sendMessage(jid, { text });
}

// ═══════════════════════════════════════════════════════════
//  BOT BOOTSTRAP
// ═══════════════════════════════════════════════════════════
async function startBot() {
    if (!FIREBASE_URL) {
        console.error(`${C.red}❌ FIREBASE_URL not set in GitHub Secrets!${C.reset}`);
        process.exit(1);
    }

    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Novopay', 'WhatsApp Bot', '2.0']
    });

    // ── Connection events ──────────────────────────────────
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.clear();
            console.log('\n' + '═'.repeat(52));
            console.log(`${C.cyan}${C.bold}   NOVOPAY WHATSAPP BOT  –  SCAN QR CODE${C.reset}`);
            console.log('  ⚠️  Tip: Click "View raw logs" (top-right) if QR is cut off');
            console.log('═'.repeat(52) + '\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            log('✅ Bot is ONLINE and ready!', C.green);
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            log(`Connection closed. Code: ${code}`, C.yellow);
            if (code !== DisconnectReason.loggedOut) {
                log('Reconnecting...', C.yellow);
                setTimeout(startBot, 3000);
            } else {
                log('❌ Logged out. Delete session_data folder and restart.', C.red);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Incoming messages ──────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg?.message) return;
        if (msg.key.remoteJid === 'status@broadcast') return;
        if (msg.key.fromMe) return; // Prevent echo loop

        const sender = msg.key.remoteJid;
        const text   = extractText(msg);

        if (!text) return; // Ignore media/stickers without text

        log(`📩 [${sender.split('@')[0]}] → "${text}"`);

        try {
            // Mark as read
            await sock.readMessages([msg.key]);
            // Typing indicator
            await sock.sendPresenceUpdate('composing', sender);

            await handleMessage(sock, sender, text);

            await sock.sendPresenceUpdate('paused', sender);
        } catch (err) {
            log(`Handler error: ${err.message}`, C.red);
            await sendText(sock, sender, '⚠️ Something went wrong on our end. Please try again or contact 1800-419-6626.');
        }
    });

    log('🚀 Novopay Bot initialising...', C.cyan);
}

// ── Entry point ────────────────────────────────────────────
startBot().catch(err => {
    console.error(`${C.red}Fatal error:${C.reset}`, err);
    process.exit(1);
});
