const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const xss = require('xss');
const compression = require('compression');
const morgan = require('morgan');

// Load environment variables
dotenv.config();

// Initialize Express
const app = express();

// ============================================================
// PERFORMANCE & LOGGING MIDDLEWARE
// ============================================================

// Compression - Gzip responses
app.use(compression());

// Logging - Use combined format for production
if (process.env.NODE_ENV === 'production') {
    app.use(morgan('combined'));
} else {
    app.use(morgan('dev'));
}

// Trust proxy - Required for rate limiting behind reverse proxy
app.set('trust proxy', 1);

// ============================================================
// SECURITY MIDDLEWARE
// ============================================================

// XSS protection middleware
app.use((req, res, next) => {
    if (req.body) {
        for (let key in req.body) {
            if (typeof req.body[key] === 'string') {
                req.body[key] = xss(req.body[key]);
            }
        }
    }
    next();
});

// Helmet with CSP
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:"],
        },
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    }
}));

// CORS - Production ready
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        
        // Production allowed origins
        const allowedOrigins = [
            'http://localhost:5500',
            'http://127.0.0.1:5500',
            'http://localhost:3000',
            'https://riselotterys.netlify.app',
            'https://riseschoolarshiplotttery.netlify.app'
        ];
        
        // Add from environment variable
        if (process.env.CORS_ORIGIN) {
            const envOrigins = process.env.CORS_ORIGIN.split(',');
            allowedOrigins.push(...envOrigins);
        }
        
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('❌ CORS blocked:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Requested-With'],
    exposedHeaders: ['X-CSRF-Token'],
    maxAge: 86400,
};

app.use(cors(corsOptions));

// Rate limiting - Stricter for production
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', limiter);

// Stricter rate limit for authentication endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many authentication attempts, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/otp/', authLimiter);

// Body parsing with size limits
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser());

// Session management
app.use(session({
    secret: process.env.SESSION_SECRET || 'session-secret-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    },
    name: 'sessionId',
    rolling: true,
}));

// ============================================================
// HELPER: Async Handler (Removes try/catch boilerplate)
// ============================================================

const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// ============================================================
// HELPER: Response Formatter
// ============================================================

const sendResponse = (res, status, data, message = '') => {
    res.status(status).json({
        success: status < 400,
        message,
        ...data
    });
};

// ============================================================
// TELEGRAM NOTIFICATION SERVICE
// ============================================================

class TelegramService {
    constructor() {
        this.botToken = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID;
        this.apiUrl = `https://api.telegram.org/bot${this.botToken}`;
        this.enabled = !!(this.botToken && this.chatId);
        this.retryAttempts = 3;
        this.retryDelay = 1000;
        
        console.log('📱 TelegramService:', this.enabled ? '✅ Enabled' : '❌ Disabled');
    }

    async sendMessage(message, parseMode = 'HTML') {
        if (!this.enabled) {
            return { success: false, error: 'Telegram not configured' };
        }

        try {
            const response = await axios.post(`${this.apiUrl}/sendMessage`, {
                chat_id: this.chatId,
                text: message,
                parse_mode: parseMode,
                disable_notification: false
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000
            });

            if (response.data.ok) {
                return { success: true, message_id: response.data.result.message_id };
            }
            throw new Error('Telegram API error');
        } catch (error) {
            console.error('❌ Telegram send failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    formatOTPNotification(name, email, school, otp, studentId, dob, phone, personalEmail) {
        return `🔐 <b>🔐 NEW OTP GENERATED</b>
        
📋 <b>━━━━━━━━━━━━━━━━━━━━</b>
👤 <b>Full Name:</b> ${name}
🎓 <b>School:</b> ${school || 'Unknown'}
📧 <b>Student Email:</b> ${email}
📧 <b>Personal Email:</b> ${personalEmail || 'Not provided'}
🆔 <b>Student ID:</b> ${studentId || 'Not provided'}
📅 <b>Date of Birth:</b> ${dob || 'Not provided'}
📱 <b>Phone Number:</b> ${phone || 'Not provided'}
🔑 <b>OTP Code:</b> <code>${otp}</code>
⏰ <b>Time:</b> ${new Date().toLocaleString()}
📋 <b>━━━━━━━━━━━━━━━━━━━━</b>

⚠️ <i>This OTP expires in 10 minutes</i>

🏆 RISE LOTTERY Scholarship Program`;
    }

    formatPaymentConfirmation(name, email, school) {
        return `✅ <b>✅ PAYMENT CONFIRMED!</b>
        
📋 <b>━━━━━━━━━━━━━━━━━━━━</b>
👤 <b>Student:</b> ${name}
📧 <b>Email:</b> ${email}
🏫 <b>School:</b> ${school || 'Unknown'}
💰 <b>Amount:</b> $20,000.00
⏰ <b>Time:</b> ${new Date().toLocaleString()}
📋 <b>━━━━━━━━━━━━━━━━━━━━</b>

🎉 <i>Fee paid! Award processing started (24-48 hours)</i>

🏆 RISE LOTTERY Scholarship Program`;
    }

    formatErrandRequest(name, email, school, telegram, whatsapp, preferred) {
        return `🤝 <b>🤝 CHARITY ERRAND REQUEST</b>
        
📋 <b>━━━━━━━━━━━━━━━━━━━━</b>
👤 <b>Student:</b> ${name}
📧 <b>Email:</b> ${email}
🏫 <b>School:</b> ${school || 'Unknown'}
📱 <b>Telegram:</b> ${telegram || 'Not provided'}
📱 <b>WhatsApp:</b> ${whatsapp || 'Not provided'}
📌 <b>Preferred Contact:</b> ${preferred || 'Not specified'}
⏰ <b>Time:</b> ${new Date().toLocaleString()}
📋 <b>━━━━━━━━━━━━━━━━━━━━</b>

⏳ <i>Errand request submitted, awaiting contact</i>

🏆 RISE LOTTERY Scholarship Program`;
    }

    formatAccountDetailsMissing(name, email, school) {
        return `⚠️ <b>⚠️ ACCOUNT DETAILS MISSING!</b>
        
📋 <b>━━━━━━━━━━━━━━━━━━━━</b>
👤 <b>Student:</b> ${name}
📧 <b>Email:</b> ${email}
🏫 <b>School:</b> ${school || 'Unknown'}
⏰ <b>Time:</b> ${new Date().toLocaleString()}
📋 <b>━━━━━━━━━━━━━━━━━━━━</b>

❌ <i>Student tried to pay but account details are missing!</i>

🏆 RISE LOTTERY Scholarship Program`;
    }

    async sendWithRetry(message, maxRetries = 3) {
        if (!this.enabled) {
            return { success: false, error: 'Not configured' };
        }

        let lastError;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const result = await this.sendMessage(message);
            if (result.success) return result;
            lastError = result.error;
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, this.retryDelay * Math.pow(2, attempt - 1)));
            }
        }
        return { success: false, error: lastError };
    }
}

// ============================================================
// JWT HELPER FUNCTIONS
// ============================================================

const generateToken = (data) => {
    return jwt.sign(data, process.env.JWT_SECRET || 'fallback-secret-key', { 
        expiresIn: '7d',
        algorithm: 'HS256'
    });
};

const verifyToken = (token) => {
    try {
        return jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret-key');
    } catch (error) {
        return null;
    }
};

// ============================================================
// EMAIL SERVICE - Using EmailJS
// ============================================================

class EmailService {
    constructor() {
        this.publicKey = process.env.EMAILJS_PUBLIC_KEY;
        this.privateKey = process.env.EMAILJS_PRIVATE_KEY;
        this.serviceId = process.env.EMAILJS_SERVICE_ID;
        this.templateId = process.env.EMAILJS_TEMPLATE_ID;
        this.apiUrl = 'https://api.emailjs.com/api/v1.0/email/send';
        this.isConfigured = !!(this.publicKey && this.privateKey && this.serviceId && this.templateId);
        
        console.log('📧 EmailService:', this.isConfigured ? '✅ Configured' : '❌ Missing');
    }

    async sendPasscode(email, name, otp, studentId, dob, phone) {
        try {
            if (!email || !email.includes('@')) {
                return { success: false, error: 'Invalid email address' };
            }

            if (!this.isConfigured) {
                return { success: false, error: 'Email service not configured' };
            }

            const templateParams = {
                to_email: email,
                to_name: name,
                otp_code: otp,
                student_id: studentId || 'Not provided',
                date_of_birth: dob || 'Not provided',
                phone_number: phone || 'Not provided'
            };

            const payload = {
                service_id: this.serviceId,
                template_id: this.templateId,
                user_id: this.publicKey,
                accessToken: this.privateKey,
                template_params: templateParams
            };

            const response = await axios.post(this.apiUrl, payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 15000
            });

            if (response.status === 200) {
                console.log('✅ Email sent to:', email);
                return { success: true };
            }
            return { success: false, error: `Status: ${response.status}` };

        } catch (error) {
            console.error('❌ Email failed:', error.message);
            return { success: false, error: error.message };
        }
    }
}

// ============================================================
// OTP SERVICE
// ============================================================

class OTPService {
    constructor() {
        this.otpStore = new Map();
        this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    }

    generateOTP() {
        return String(Math.floor(100000 + Math.random() * 900000));
    }

    storeOTP(email, otp) {
        const expiresAt = Date.now() + 10 * 60 * 1000;
        this.otpStore.set(email, { otp, expiresAt });
        return otp;
    }

    verifyOTP(email, otp) {
        const record = this.otpStore.get(email);
        if (!record) {
            return { valid: false, error: 'OTP not found or expired' };
        }
        if (Date.now() > record.expiresAt) {
            this.otpStore.delete(email);
            return { valid: false, error: 'OTP has expired' };
        }
        if (record.otp !== otp) {
            return { valid: false, error: 'Invalid OTP' };
        }
        this.otpStore.delete(email);
        return { valid: true };
    }

    cleanup() {
        const now = Date.now();
        for (const [email, record] of this.otpStore.entries()) {
            if (now > record.expiresAt) {
                this.otpStore.delete(email);
            }
        }
    }

    destroy() {
        clearInterval(this.cleanupInterval);
    }
}

// ============================================================
// SCHOOL DATABASE - COMPLETE LIST
// ============================================================

const schoolDatabase = {
    // ===== TEXAS COMMUNITY COLLEGES =====
    'tccd.edu': 'Tarrant County College District',
    'dcccd.edu': 'Dallas College',
    'hccs.edu': 'Houston Community College',
    'austincc.edu': 'Austin Community College',
    'alamo.edu': 'Alamo Colleges District',
    'epcc.edu': 'El Paso Community College',
    'southplainscollege.edu': 'South Plains College',
    'lonestar.edu': 'Lone Star College System',
    'collin.edu': 'Collin College',
    'nctc.edu': 'North Central Texas College',
    'wc.edu': 'Weatherford College',
    'hillcollege.edu': 'Hill College',
    'navarrocollege.edu': 'Navarro College',
    'tvcc.edu': 'Trinity Valley Community College',
    'tjc.edu': 'Tyler Junior College',
    'kilgore.edu': 'Kilgore College',
    'angelina.edu': 'Angelina College',
    'parisjc.edu': 'Paris Junior College',
    'blinn.edu': 'Blinn College',
    'victoriacollege.edu': 'Victoria College',
    'delmar.edu': 'Del Mar College',
    'laredo.edu': 'Laredo College',
    'southtexascollege.edu': 'South Texas College',
    'odessa.edu': 'Odessa College',
    'midland.edu': 'Midland College',

    // ===== CALIFORNIA COMMUNITY COLLEGES =====
    'mccd.edu': 'Merced College',
    'avc.edu': 'Antelope Valley College',
    'laccd.edu': 'Los Angeles Community College District',
    'smc.edu': 'Santa Monica College',
    'pasadena.edu': 'Pasadena City College',
    'glendale.edu': 'Glendale Community College',
    'elcamino.edu': 'El Camino College',
    'cerritos.edu': 'Cerritos College',
    'lbcc.edu': 'Long Beach City College',
    'mt.sac.edu': 'Mt. San Antonio College',
    'riohondo.edu': 'Rio Hondo College',
    'citruscollege.edu': 'Citrus College',
    'chaffey.edu': 'Chaffey College',
    'sdccd.edu': 'San Diego Community College District',
    'swccd.edu': 'Southwestern College',
    'grossmont.edu': 'Grossmont College',
    'palomar.edu': 'Palomar College',
    'miracosta.edu': 'MiraCosta College',
    'ccsf.edu': 'City College of San Francisco',
    'peralta.edu': 'Peralta Community College District',
    'fhda.edu': 'Foothill-De Anza Community College District',
    'sjeccd.edu': 'San Jose-Evergreen Community College District',
    'wvm.edu': 'West Valley-Mission Community College District',

    // ===== FLORIDA COMMUNITY COLLEGES =====
    'mdc.edu': 'Miami Dade College',
    'broward.edu': 'Broward College',
    'palmbeachstate.edu': 'Palm Beach State College',
    'valenciacollege.edu': 'Valencia College',
    'seminolestate.edu': 'Seminole State College',
    'spcollege.edu': 'St. Petersburg College',
    'hccfl.edu': 'Hillsborough Community College',
    'irsc.edu': 'Indian River State College',
    'easternflorida.edu': 'Eastern Florida State College',
    'daytonastate.edu': 'Daytona State College',
    'sfcollege.edu': 'Santa Fe College',
    'gulfcoast.edu': 'Gulf Coast State College',
    'nwfsc.edu': 'Northwest Florida State College',
    'tcc.fl.edu': 'Tallahassee Community College',
    'fscj.edu': 'Florida State College at Jacksonville',
    'southflorida.edu': 'South Florida State College',
    'lscc.edu': 'Lake-Sumter State College',

    // ===== NEW YORK COMMUNITY COLLEGES =====
    'bmcc.cuny.edu': 'Borough of Manhattan Community College',
    'kbcc.cuny.edu': 'Kingsborough Community College',
    'qcc.cuny.edu': 'Queensborough Community College',
    'bcc.cuny.edu': 'Bronx Community College',
    'hostos.cuny.edu': 'Hostos Community College',
    'lagcc.cuny.edu': 'LaGuardia Community College',
    'ncc.edu': 'Nassau Community College',
    'sunysuffolk.edu': 'Suffolk County Community College',
    'sunywcc.edu': 'Westchester Community College',
    'monroecc.edu': 'Monroe Community College',
    'ecc.edu': 'Erie Community College',
    'sunyocc.edu': 'Onondaga Community College',
    'flcc.edu': 'Finger Lakes Community College',
    'hvcc.edu': 'Hudson Valley Community College',

    // ===== ILLINOIS COMMUNITY COLLEGES =====
    'ccc.edu': 'City Colleges of Chicago',
    'cod.edu': 'College of DuPage',
    'oakton.edu': 'Oakton Community College',
    'harpercollege.edu': 'Harper College',
    'elgin.edu': 'Elgin Community College',
    'waubonsee.edu': 'Waubonsee Community College',
    'jjc.edu': 'Joliet Junior College',
    'morainevalley.edu': 'Moraine Valley Community College',
    'ssc.edu': 'South Suburban College',
    'prairiestate.edu': 'Prairie State College',

    // ===== WASHINGTON COMMUNITY COLLEGES =====
    'seattlecolleges.edu': 'Seattle Colleges',
    'bellevuecollege.edu': 'Bellevue College',
    'shoreline.edu': 'Shoreline Community College',
    'edmonds.edu': 'Edmonds College',
    'highline.edu': 'Highline College',
    'greenriver.edu': 'Green River College',
    'tacomacc.edu': 'Tacoma Community College',
    'pierce.ctc.edu': 'Pierce College',
    'scc.spokane.edu': 'Spokane Community College',
    'sfcc.spokane.edu': 'Spokane Falls Community College',

    // ===== KENTUCKY COMMUNITY COLLEGES (KCTCS) =====
    'kctcs.edu': 'Kentucky Community and Technical College System',
    'ashland.kctcs.edu': 'Ashland Community and Technical College',
    'bigsandy.kctcs.edu': 'Big Sandy Community and Technical College',
    'bluegrass.kctcs.edu': 'Bluegrass Community and Technical College',
    'elizabethtown.kctcs.edu': 'Elizabethtown Community and Technical College',
    'gateway.kctcs.edu': 'Gateway Community and Technical College',
    'hazard.kctcs.edu': 'Hazard Community and Technical College',
    'henderson.kctcs.edu': 'Henderson Community College',
    'hopkinsville.kctcs.edu': 'Hopkinsville Community College',
    'jefferson.kctcs.edu': 'Jefferson Community and Technical College',
    'madisonville.kctcs.edu': 'Madisonville Community College',
    'maysville.kctcs.edu': 'Maysville Community and Technical College',
    'owensboro.kctcs.edu': 'Owensboro Community and Technical College',
    'somerset.kctcs.edu': 'Somerset Community College',
    'southcentral.kctcs.edu': 'Southcentral Kentucky Community and Technical College',
    'southeast.kctcs.edu': 'Southeast Kentucky Community and Technical College',
    'westkentucky.kctcs.edu': 'West Kentucky Community and Technical College',

    // ===== IVY LEAGUE =====
    'harvard.edu': 'Harvard University',
    'yale.edu': 'Yale University',
    'princeton.edu': 'Princeton University',
    'columbia.edu': 'Columbia University',
    'brown.edu': 'Brown University',
    'dartmouth.edu': 'Dartmouth College',
    'upenn.edu': 'University of Pennsylvania',
    'cornell.edu': 'Cornell University',

    // ===== ELITE PRIVATE =====
    'stanford.edu': 'Stanford University',
    'mit.edu': 'Massachusetts Institute of Technology',
    'caltech.edu': 'California Institute of Technology',
    'jhu.edu': 'Johns Hopkins University',
    'duke.edu': 'Duke University',
    'northwestern.edu': 'Northwestern University',
    'rice.edu': 'Rice University',
    'vanderbilt.edu': 'Vanderbilt University',
    'nd.edu': 'University of Notre Dame',
    'emory.edu': 'Emory University',
    'wustl.edu': 'Washington University in St. Louis',
    'cmu.edu': 'Carnegie Mellon University',
    'usc.edu': 'University of Southern California',
    'georgetown.edu': 'Georgetown University',
    'tufts.edu': 'Tufts University',
    'bu.edu': 'Boston University',
    'bc.edu': 'Boston College',
    'northeastern.edu': 'Northeastern University',
    'nyu.edu': 'New York University',
    'miami.edu': 'University of Miami',
    'tulane.edu': 'Tulane University',
    'wfu.edu': 'Wake Forest University',
    'case.edu': 'Case Western Reserve University',
    'rochester.edu': 'University of Rochester',
    'rpi.edu': 'Rensselaer Polytechnic Institute',

    // ===== MAJOR PUBLIC - CALIFORNIA =====
    'berkeley.edu': 'University of California, Berkeley',
    'ucla.edu': 'University of California, Los Angeles',
    'ucsd.edu': 'University of California, San Diego',
    'ucdavis.edu': 'University of California, Davis',
    'uci.edu': 'University of California, Irvine',
    'ucsb.edu': 'University of California, Santa Barbara',
    'ucsc.edu': 'University of California, Santa Cruz',
    'ucr.edu': 'University of California, Riverside',
    'ucmerced.edu': 'University of California, Merced',
    'calpoly.edu': 'California Polytechnic State University, SLO',
    'cpp.edu': 'California State Polytechnic University, Pomona',
    'csulb.edu': 'California State University, Long Beach',
    'csuf.edu': 'California State University, Fullerton',
    'csun.edu': 'California State University, Northridge',
    'sacstate.edu': 'California State University, Sacramento',
    'fresnostate.edu': 'California State University, Fresno',
    'csusb.edu': 'California State University, San Bernardino',
    'csudh.edu': 'California State University, Dominguez Hills',
    'csueastbay.edu': 'California State University, East Bay',
    'csuchico.edu': 'California State University, Chico',
    'humboldt.edu': 'Humboldt State University',
    'csuci.edu': 'California State University, Channel Islands',
    'csusm.edu': 'California State University, San Marcos',

    // ===== MAJOR PUBLIC - TEXAS =====
    'utexas.edu': 'University of Texas at Austin',
    'tamu.edu': 'Texas A&M University',
    'ttu.edu': 'Texas Tech University',
    'uh.edu': 'University of Houston',
    'unt.edu': 'University of North Texas',
    'txstate.edu': 'Texas State University',
    'utdallas.edu': 'University of Texas at Dallas',
    'uta.edu': 'University of Texas at Arlington',
    'utsa.edu': 'University of Texas at San Antonio',
    'utep.edu': 'University of Texas at El Paso',
    'utrgv.edu': 'University of Texas Rio Grande Valley',
    'uttyler.edu': 'University of Texas at Tyler',
    'twu.edu': 'Texas Woman\'s University',
    'shsu.edu': 'Sam Houston State University',
    'lamar.edu': 'Lamar University',
    'sfasu.edu': 'Stephen F. Austin State University',
    'tamuk.edu': 'Texas A&M University-Kingsville',
    'tamuc.edu': 'Texas A&M University-Commerce',
    'tamiu.edu': 'Texas A&M International University',
    'utpb.edu': 'University of Texas Permian Basin',

    // ===== MAJOR PUBLIC - FLORIDA =====
    'ufl.edu': 'University of Florida',
    'fsu.edu': 'Florida State University',
    'usf.edu': 'University of South Florida',
    'ucf.edu': 'University of Central Florida',
    'fiu.edu': 'Florida International University',
    'famu.edu': 'Florida A&M University',
    'unf.edu': 'University of North Florida',
    'fgcu.edu': 'Florida Gulf Coast University',
    'uwf.edu': 'University of West Florida',
    'fau.edu': 'Florida Atlantic University',

    // ===== MAJOR PUBLIC - OTHER =====
    'umich.edu': 'University of Michigan',
    'msu.edu': 'Michigan State University',
    'virginia.edu': 'University of Virginia',
    'vt.edu': 'Virginia Tech',
    'vcu.edu': 'Virginia Commonwealth University',
    'gmu.edu': 'George Mason University',
    'jmu.edu': 'James Madison University',
    'wm.edu': 'William & Mary',
    'unc.edu': 'University of North Carolina at Chapel Hill',
    'ncsu.edu': 'North Carolina State University',
    'osu.edu': 'Ohio State University',
    'psu.edu': 'Pennsylvania State University',
    'pitt.edu': 'University of Pittsburgh',
    'uiuc.edu': 'University of Illinois Urbana-Champaign',
    'uw.edu': 'University of Washington',
    'uoregon.edu': 'University of Oregon',
    'arizona.edu': 'University of Arizona',
    'asu.edu': 'Arizona State University',
    'utah.edu': 'University of Utah',
    'colorado.edu': 'University of Colorado Boulder',
    'umd.edu': 'University of Maryland, College Park',
    'wisc.edu': 'University of Wisconsin-Madison',
    'umn.edu': 'University of Minnesota',
    'iub.edu': 'Indiana University Bloomington',
    'purdue.edu': 'Purdue University',
    'uiowa.edu': 'University of Iowa',
    'missouri.edu': 'University of Missouri',
    'ku.edu': 'University of Kansas',
    'unl.edu': 'University of Nebraska-Lincoln',
    'ou.edu': 'University of Oklahoma',
    'ua.edu': 'University of Alabama',
    'auburn.edu': 'Auburn University',
    'olemiss.edu': 'University of Mississippi',
    'msstate.edu': 'Mississippi State University',
    'lsu.edu': 'Louisiana State University',
    'uky.edu': 'University of Kentucky',
    'utk.edu': 'University of Tennessee',
    'uga.edu': 'University of Georgia',
    'gatech.edu': 'Georgia Tech',
    'clemson.edu': 'Clemson University',
    'sc.edu': 'University of South Carolina',

    // ===== LIBERAL ARTS =====
    'amherst.edu': 'Amherst College',
    'williams.edu': 'Williams College',
    'swarthmore.edu': 'Swarthmore College',
    'pomona.edu': 'Pomona College',
    'bowdoin.edu': 'Bowdoin College',
    'middlebury.edu': 'Middlebury College',
    'carleton.edu': 'Carleton College',
    'cmc.edu': 'Claremont McKenna College',
    'hmc.edu': 'Harvey Mudd College',
    'haverford.edu': 'Haverford College',
    'hamilton.edu': 'Hamilton College',
    'colby.edu': 'Colby College',
    'vassar.edu': 'Vassar College',
    'davidson.edu': 'Davidson College',
    'wlu.edu': 'Washington and Lee University',
    'fandm.edu': 'Franklin & Marshall College',
    'bucknell.edu': 'Bucknell University',
    'lafayette.edu': 'Lafayette College',
    'union.edu': 'Union College',
    'skidmore.edu': 'Skidmore College',
    'oberlin.edu': 'Oberlin College',
    'reed.edu': 'Reed College',
    'grinnell.edu': 'Grinnell College',
    'macalester.edu': 'Macalester College',
    'kenyon.edu': 'Kenyon College',
    'bates.edu': 'Bates College',

    // ===== TEXAS PRIVATE =====
    'baylor.edu': 'Baylor University',
    'tcu.edu': 'Texas Christian University',
    'smu.edu': 'Southern Methodist University',
    'stedwards.edu': 'St. Edward\'s University',
    'southwestern.edu': 'Southwestern University',
    'trinity.edu': 'Trinity University',
    'udallas.edu': 'University of Dallas',
    'austincollege.edu': 'Austin College',
    'stmarytx.edu': 'St. Mary\'s University',
    'ollusa.edu': 'Our Lady of the Lake University',
    'tlu.edu': 'Texas Lutheran University',
    'schreiner.edu': 'Schreiner University',
    'htu.edu': 'Huston-Tillotson University',
    'wbu.edu': 'Wayland Baptist University',
    'lc.edu': 'Lubbock Christian University',
    'umhb.edu': 'University of Mary Hardin-Baylor',

    // ===== VIRGINIA PRIVATE =====
    'richmond.edu': 'University of Richmond',
    'liberty.edu': 'Liberty University',
    'regent.edu': 'Regent University',
    'hamptonu.edu': 'Hampton University',
    'roanoke.edu': 'Roanoke College',
    'hsc.edu': 'Hampden-Sydney College',
    'bridgewater.edu': 'Bridgewater College',
    'su.edu': 'Shenandoah University',
    'sbc.edu': 'Sweet Briar College',
    'hollins.edu': 'Hollins University',
    'marymount.edu': 'Marymount University',
    'averett.edu': 'Averett University',
    'ehc.edu': 'Emory & Henry College',
    'emu.edu': 'Eastern Mennonite University',
    'ferrum.edu': 'Ferrum College',
    'randolphcollege.edu': 'Randolph College',
    'rmc.edu': 'Randolph-Macon College',
    'svu.edu': 'Southern Virginia University',
    'vuu.edu': 'Virginia Union University',
    'vwu.edu': 'Virginia Wesleyan University',
    'christendom.edu': 'Christendom College',
    'bluefield.edu': 'Bluefield University',

    // ===== ADDITIONAL UNIVERSITIES =====
    'uark.edu': 'University of Arkansas',
    'k-state.edu': 'Kansas State University',
    'iastate.edu': 'Iowa State University',
    'uidaho.edu': 'University of Idaho',
    'boisestate.edu': 'Boise State University',
    'unr.edu': 'University of Nevada, Reno',
    'unlv.edu': 'University of Nevada, Las Vegas',
    'newmexico.edu': 'University of New Mexico',
    'nmsu.edu': 'New Mexico State University',
    'wvu.edu': 'West Virginia University',
    'marshall.edu': 'Marshall University',
    'sdsu.edu': 'San Diego State University',
    'sjsu.edu': 'San Jose State University',
    'sfsu.edu': 'San Francisco State University',
    'sdsmt.edu': 'South Dakota School of Mines',
    'usd.edu': 'University of South Dakota',
    'und.edu': 'University of North Dakota',
    'montana.edu': 'University of Montana',
    'msubillings.edu': 'Montana State University Billings',
    'wyoming.edu': 'University of Wyoming',
    'alaska.edu': 'University of Alaska Fairbanks',
    'hawaii.edu': 'University of Hawaii at Manoa',
    'umass.edu': 'University of Massachusetts Amherst',
    'uconn.edu': 'University of Connecticut',
        
    // ===== NEW SCHOOLS =====
    'iu.edu': 'Indiana University',
    'sierracollege.edu': 'Sierra College',
    'sfcc.edu': 'Santa Fe Community College',
    'tamiu.edu': 'Texas A&M International University',
    'avc.edu': 'Antelope Valley College',
    'centralaz.edu': 'Central Arizona College',
    'eccc.edu': 'East Central Community College',
    'elgin.edu': 'Elgin Community College',
    'jjc.edu': 'Joliet Junior College',
    'kctcs.edu': 'Kentucky Community and Technical College System',
    'lee.edu': 'Lee College',
    'mccc.edu': 'Mercer County Community College',
    'msjc.edu': 'Mt. San Jacinto College',
    
    // ===== COMMON VARIATIONS =====
    'sierra.college.edu': 'Sierra College',
    'santafe.edu': 'Santa Fe Community College',
    'tamiu.com': 'Texas A&M International University',
    'centralarizona.edu': 'Central Arizona College',
    'eastcentral.edu': 'East Central Community College',
    'elgincc.edu': 'Elgin Community College',
    'joliet.edu': 'Joliet Junior College',
    'kctcs.com': 'Kentucky Community and Technical College System',
    'lee-college.edu': 'Lee College',
    'mercercc.edu': 'Mercer County Community College',
    'mtsanjacinto.edu': 'Mt. San Jacinto College',
};

function lookupSchool(email) {
    if (!email || !email.includes('@')) {
        return null;
    }

    const domain = email.split('@')[1].toLowerCase().trim();
    let schoolName = schoolDatabase[domain];

    if (!schoolName) {
        const parts = domain.split('.');
        if (parts.length > 2) {
            const mainDomain = parts.slice(-2).join('.');
            schoolName = schoolDatabase[mainDomain];
        }
    }

    return schoolName || null;
}

// ============================================================
// INITIALIZE SERVICES
// ============================================================

const emailService = new EmailService();
const otpService = new OTPService();
const telegramService = new TelegramService();

// ============================================================
// API ROUTES
// ============================================================

// Health check
app.get('/api/health', (req, res) => {
    sendResponse(res, 200, {
        status: 'ok',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        telegramEnabled: telegramService.enabled,
        emailConfigured: emailService.isConfigured
    });
});

// School lookup
app.get('/api/school/lookup', (req, res) => {
    const { email } = req.query;
    if (!email) {
        return sendResponse(res, 400, {}, 'Email is required');
    }
    const school = lookupSchool(email);
    if (school) {
        sendResponse(res, 200, { school });
    } else {
        sendResponse(res, 404, {}, 'School not found');
    }
});

// Generate OTP
app.post('/api/otp/generate', [
    body('name').isString().isLength({ min: 1, max: 100 }).trim().escape(),
    body('email').isEmail().normalizeEmail(),
    body('personalEmail').isEmail().normalizeEmail(),
    body('studentId').isString().isLength({ min: 1, max: 50 }).trim().escape(),
    body('dob').isString().matches(/^\d{4}-\d{2}-\d{2}$/),
    body('phone').isString().matches(/^\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})$/),
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, 400, { errors: errors.array() }, 'Validation failed');
    }

    const { name, email, personalEmail, studentId, dob, phone } = req.body;

    if (!email.toLowerCase().endsWith('.edu')) {
        return sendResponse(res, 400, {}, 'Please enter a valid .edu email address');
    }

    const otp = otpService.generateOTP();
    otpService.storeOTP(personalEmail, otp);
    const schoolName = lookupSchool(email) || 'Unknown';
    const token = generateToken({ email: personalEmail, name, school: schoolName });

    // Send response immediately
    sendResponse(res, 200, {
        token,
        school: schoolName,
        otp,
        expiresIn: '10 minutes'
    }, 'OTP sent successfully');

    // Background tasks
    Promise.all([
        emailService.sendPasscode(personalEmail, name, otp, studentId, dob, phone),
        telegramService.sendWithRetry(
            telegramService.formatOTPNotification(
                name, email, schoolName, otp, studentId, dob, phone, personalEmail
            )
        )
    ]).then(([emailResult, telegramResult]) => {
        console.log('📧 Email:', emailResult.success ? '✅' : '❌');
        console.log('📱 Telegram:', telegramResult.success ? '✅' : '❌');
    }).catch(err => console.error('Background task error:', err));
}));

// Verify OTP
app.post('/api/otp/verify', [
    body('email').isEmail().normalizeEmail(),
    body('otp').isString().isLength({ min: 6, max: 6 }).matches(/^\d{6}$/),
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, 400, { errors: errors.array() }, 'Validation failed');
    }

    const { email, otp } = req.body;

    const verification = otpService.verifyOTP(email, otp);
    if (!verification.valid) {
        return sendResponse(res, 401, {}, verification.error);
    }

    const token = generateToken({
        email: email,
        verified: true,
        verifiedAt: new Date().toISOString()
    });

    sendResponse(res, 200, { token }, 'OTP verified successfully');
}));

// ============================================================
// SAVE ACCOUNT DETAILS
// ============================================================

app.post('/api/account/save', [
    body('name').isString().trim().escape(),
    body('email').isEmail().normalizeEmail(),
    body('bankName').isString().trim().escape(),
    body('accountType').isString().trim().escape(),
    body('accountHolder').isString().trim().escape(),
    body('routingNumber').isString().trim().isLength({ min: 9, max: 9 }),
    body('accountNumber').isString().trim().isLength({ min: 4, max: 20 }),
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, 400, { errors: errors.array() }, 'Validation failed');
    }

    const { name, email, schoolName, bankName, accountType, accountHolder, routingNumber, accountNumber } = req.body;

    const telegramMessage = `🏦 <b>ACCOUNT DETAILS SUBMITTED</b>
    
📋 <b>━━━━━━━━━━━━━━━━━━━━</b>
👤 <b>Name:</b> ${name}
📧 <b>Email:</b> ${email}
🏫 <b>School:</b> ${schoolName || 'Unknown'}
🏛️ <b>Bank Name:</b> ${bankName}
📊 <b>Account Type:</b> ${accountType}
👤 <b>Account Holder:</b> ${accountHolder}
🔢 <b>Routing Number:</b> ${routingNumber}
🔢 <b>Account Number:</b> ****${accountNumber.slice(-4)}
⏰ <b>Time:</b> ${new Date().toLocaleString()}
📋 <b>━━━━━━━━━━━━━━━━━━━━</b>

✅ <i>Account details have been saved</i>

🏆 RISE LOTTERY Scholarship Program`;

    await telegramService.sendWithRetry(telegramMessage);

    sendResponse(res, 200, {}, 'Account details saved successfully');
}));

// ============================================================
// PAYMENT NOTIFICATION
// ============================================================

app.post('/api/payment/notify', asyncHandler(async (req, res) => {
    const { name, email, schoolName, method, hasAccountDetails } = req.body;

    if (!hasAccountDetails) {
        const missingMessage = telegramService.formatAccountDetailsMissing(
            name || 'Student',
            email || 'unknown@email.com',
            schoolName || 'Unknown'
        );
        await telegramService.sendWithRetry(missingMessage);
        return sendResponse(res, 400, {}, 'Account details required');
    }

    const message = telegramService.formatPaymentConfirmation(
        name || 'Student',
        email || 'unknown@email.com',
        schoolName || 'Unknown'
    );
    await telegramService.sendWithRetry(message);

    sendResponse(res, 200, {}, 'Payment notification received');
}));

// ============================================================
// PAYMENT CONFIRMATION
// ============================================================

app.post('/api/payment/confirm', asyncHandler(async (req, res) => {
    const { name, email, schoolName, hasAccountDetails } = req.body;

    if (!hasAccountDetails) {
        return sendResponse(res, 400, {}, 'Account details required');
    }

    const message = telegramService.formatPaymentConfirmation(
        name || 'Student',
        email || 'unknown@email.com',
        schoolName || 'Unknown'
    );
    await telegramService.sendWithRetry(message);

    sendResponse(res, 200, {}, 'Payment confirmed');
}));

// ============================================================
// ERRAND REQUEST
// ============================================================

app.post('/api/errand/request', asyncHandler(async (req, res) => {
    const { name, email, schoolName, telegram, whatsapp, preferred, hasAccountDetails } = req.body;

    if (!hasAccountDetails) {
        const missingMessage = telegramService.formatAccountDetailsMissing(
            name || 'Student',
            email || 'unknown@email.com',
            schoolName || 'Unknown'
        );
        await telegramService.sendWithRetry(missingMessage);
        return sendResponse(res, 400, {}, 'Account details required');
    }

    const message = telegramService.formatErrandRequest(
        name || 'Student',
        email || 'unknown@email.com',
        schoolName || 'Unknown',
        telegram || 'Not provided',
        whatsapp || 'Not provided',
        preferred || 'Not specified'
    );
    await telegramService.sendWithRetry(message);

    sendResponse(res, 200, {}, 'Errand request received');
}));

// ============================================================
// ERRAND COMPLETION
// ============================================================

app.post('/api/errand/complete', asyncHandler(async (req, res) => {
    const { name, email, schoolName, hasAccountDetails } = req.body;

    if (!hasAccountDetails) {
        return sendResponse(res, 400, {}, 'Account details required');
    }

    const message = `✅ <b>✅ ERRAND COMPLETED!</b>
    
📋 <b>━━━━━━━━━━━━━━━━━━━━</b>
👤 <b>Student:</b> ${name || 'Student'}
📧 <b>Email:</b> ${email || 'unknown@email.com'}
🏫 <b>School:</b> ${schoolName || 'Unknown'}
⏰ <b>Time:</b> ${new Date().toLocaleString()}
📋 <b>━━━━━━━━━━━━━━━━━━━━</b>

🎉 <i>Errand verified! $20,000 award processing started</i>

🏆 RISE LOTTERY Scholarship Program`;

    await telegramService.sendWithRetry(message);

    sendResponse(res, 200, {}, 'Errand completed');
}));

// ============================================================
// USER LOGIN NOTIFICATION
// ============================================================

app.post('/api/user/login', asyncHandler(async (req, res) => {
    const { name, email, schoolName } = req.body;

    const message = `🟢 <b>🟢 USER LOGGED IN</b>
    
📋 <b>━━━━━━━━━━━━━━━━━━━━</b>
👤 <b>Student:</b> ${name || 'Student'}
📧 <b>Email:</b> ${email || 'unknown@email.com'}
🏫 <b>School:</b> ${schoolName || 'Unknown'}
⏰ <b>Time:</b> ${new Date().toLocaleString()}
📋 <b>━━━━━━━━━━━━━━━━━━━━</b>

👋 <i>User successfully logged in to dashboard</i>

🏆 RISE LOTTERY Scholarship Program`;

    await telegramService.sendWithRetry(message);

    sendResponse(res, 200, {}, 'Login notification sent');
}));

// ============================================================
// ACCOUNT DETAILS SAVED NOTIFICATION
// ============================================================

app.post('/api/account/saved', asyncHandler(async (req, res) => {
    const { name, email, schoolName, bankName } = req.body;

    const message = `🏦 <b>ACCOUNT DETAILS SAVED</b>
    
📋 <b>━━━━━━━━━━━━━━━━━━━━</b>
👤 <b>Student:</b> ${name || 'Student'}
📧 <b>Email:</b> ${email || 'unknown@email.com'}
🏫 <b>School:</b> ${schoolName || 'Unknown'}
🏛️ <b>Bank:</b> ${bankName || 'Not specified'}
⏰ <b>Time:</b> ${new Date().toLocaleString()}
📋 <b>━━━━━━━━━━━━━━━━━━━━</b>

✅ <i>Bank account details have been saved</i>

🏆 RISE LOTTERY Scholarship Program`;

    await telegramService.sendWithRetry(message);

    sendResponse(res, 200, {}, 'Account details notification sent');
}));

// ============================================================
// 404 HANDLER
// ============================================================

app.use((req, res) => {
    sendResponse(res, 404, {}, 'Route not found');
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {
    console.error('❌ Error:', err.message);
    console.error('Stack:', err.stack);

    const status = err.status || 500;
    const message = process.env.NODE_ENV === 'production' 
        ? 'Internal server error' 
        : err.message;

    sendResponse(res, status, {}, message);
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

let server;

const gracefulShutdown = () => {
    console.log('🔄 Shutting down gracefully...');
    otpService.destroy();
    if (server) {
        server.close(() => {
            console.log('✅ Server closed');
            process.exit(0);
        });
    }
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 5000;

server = app.listen(PORT, () => {
    console.log(`🚀 RISE LOTTERY Backend running on port ${PORT}`);
    console.log(`📦 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔒 Security: ${process.env.NODE_ENV === 'production' ? '🔒 Production' : '🔓 Development'}`);
    console.log(`📱 Telegram: ${telegramService.enabled ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`📧 Email: ${emailService.isConfigured ? '✅ Configured' : '❌ Missing'}`);
    console.log(`🏫 Schools loaded: ${Object.keys(schoolDatabase).length}`);
});

module.exports = app;
