/*
╔══════════════════════════════════════════════════════════════╗
║          🔪 THE SURGEON BOT — FMZ QUANT EDITION             ║
║          بوت الجراح — منصة FMZ Quant — عقود بينانس الآجلة  ║
╚══════════════════════════════════════════════════════════════╝

استراتيجية سكالبينج كاملة لعقود Binance Futures الدائمة USDT-M
تعمل على منصة FMZ Quant (fmz.com)

المنطق:
  - مسح أفضل 200 رمز حسب حجم التداول 24 ساعة
  - 5 شروط دخول: تقاطع EMA، RSI، VWAP، ارتفاع الحجم، تقاطع MACD
  - هدف الربح: 2% | وقف الخسارة: 0.7% | الحد الأقصى للصفقة: 20 دقيقة
  - مضاعفة كاملة للرأسمال (Full Compounding)

الدوال المستخدمة من FMZ:
  exchange.GetRecords()      — جلب الشمعات
  exchange.GetTicker()       — جلب السعر الحالي
  exchange.SetContractType() — تحديد الرمز
  exchange.Buy()             — أمر شراء
  exchange.Sell()            — أمر بيع
  exchange.GetAccount()      — جلب الرصيد
  exchange.GetPosition()     — جلب المراكز المفتوحة
  exchange.IO()              — استدعاء Binance API مباشرة
*/

// =====================================================================
// الإعدادات الرئيسية — Main Configuration
// يمكن تغييرها من لوحة تحكم FMZ عبر معاملات الاستراتيجية
// =====================================================================
var INITIAL_CAPITAL      = 500;          // رأس المال الأولي بالدولار
var TOP_SYMBOLS_COUNT    = 200;          // عدد الرموز الأعلى بحجم التداول
var TIMEFRAME            = PERIOD_M5;   // الإطار الزمني (5 دقائق)
var CANDLES_LIMIT        = 201;         // +1 لاستبعاد الشمعة غير المغلقة
var LEVERAGE             = 10;          // الرافعة المالية
var TP_PCT_LONG          = 1.020;       // هدف الربح للشراء  (+2%)
var TP_PCT_SHORT         = 0.980;       // هدف الربح للبيع   (-2%)
var SL_PCT_LONG          = 0.993;       // وقف الخسارة للشراء (-0.7%)
var SL_PCT_SHORT         = 1.007;       // وقف الخسارة للبيع  (+0.7%)
var MAX_TRADE_MINUTES    = 20;          // الحد الأقصى لمدة الصفقة
var SCAN_INTERVAL_MS     = 30000;       // فاصل المسح بالميلي ثانية (30 ثانية)
var SYMBOL_DELAY_MS      = 200;         // تأخير بين الرموز لتجنب تجاوز الحد
var POSITION_POLL_MS     = 10000;       // استطلاع المراكز كل 10 ثوانٍ
var MIN_BALANCE          = 50;          // الحد الأدنى للرصيد قبل الإيقاف
var SYMBOL_REFRESH_HOURS = 4;           // تحديث قائمة الرموز كل 4 ساعات
var DASHBOARD_INTERVAL   = 300000;      // طباعة اللوحة كل 5 دقائق (ms)

// =====================================================================
// العملات المستقرة المستثناة — Excluded Stablecoins
// =====================================================================
var STABLE_COINS = ["USDC", "BUSD", "TUSD", "USDP", "DAI", "FDUSD", "USDT"];

// =====================================================================
// المتغيرات العالمية — Global State Variables
// =====================================================================
var activeSymbols       = [];    // قائمة الرموز النشطة (بصيغة FMZ: "BTC_USDT")
var symbolsLastUpdated  = 0;     // وقت آخر تحديث لقائمة الرموز (ms)
var currentTrade        = null;  // بيانات الصفقة الحالية أو null إذا لا توجد صفقة

// إحصائيات الأداء
var stats = {
    balance:      INITIAL_CAPITAL,
    totalTrades:  0,
    wins:         0,
    losses:       0,
    timeouts:     0,
    totalPnl:     0.0
};

var lastDashboardPrint = 0;   // وقت آخر طباعة للوحة

// =====================================================================
// تحويل صيغة الرمز — Symbol Format Conversion
// FMZ تستخدم: "BTC_USDT"  |  Binance API تستخدم: "BTCUSDT"
// =====================================================================

 // تحويل صيغة Binance API إلى صيغة FMZ
 // مثال: "BTCUSDT" -> "BTC_USDT"
function binanceToFmz(binanceSymbol) {
    // نزيل "USDT" من النهاية ثم نضيف "_USDT"
    if (binanceSymbol.slice(-4) === "USDT") {
        var base = binanceSymbol.slice(0, -4); // إزالة آخر 4 أحرف "USDT"
        return base + "_USDT";
    }
    return binanceSymbol;
}

 // تحويل صيغة FMZ إلى صيغة Binance API
 // مثال: "BTC_USDT" -> "BTCUSDT"
function fmzToBinance(fmzSymbol) {
    return fmzSymbol.replace("_", "");
}

// =====================================================================
// استدعاء API مع إعادة المحاولة — API Call with Retry
// =====================================================================

 // تنفيذ دالة مع إعادة المحاولة 3 مرات عند الفشل
 // يستقبل دالة (fn) وسيتم تنفيذها حتى تنجح أو تستنفذ المحاولات
function retryCall(fn, maxRetries, delayMs) {
    maxRetries = maxRetries || 3;
    delayMs    = delayMs    || 2000;

    for (var attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            var result = fn();
            if (result !== null && result !== undefined) {
                return result;
            }
        } catch (e) {
            Log("[تحذير] محاولة", attempt, "/", maxRetries, "فشلت:", e.message || e);
        }
        if (attempt < maxRetries) {
            Sleep(delayMs);
        }
    }
    return null;
}

// =====================================================================
// جلب أفضل 200 رمز حسب الحجم — Fetch Top 200 Symbols by Volume
// =====================================================================

 // جلب بيانات 24 ساعة لجميع رموز Binance Futures
 // ثم تصفية وترتيب حسب حجم التداول، وإعادة أعلى TOP_SYMBOLS_COUNT رمزاً
 // يستخدم Binance Futures REST API مباشرة عبر exchange.IO
function fetchTopSymbols() {
    Log("[رموز] جاري تحديث قائمة الرموز...");

    var tickers = retryCall(function () {
        // جلب بيانات الـ 24 ساعة من Binance Futures
        return exchange.IO("api", "GET", "/fapi/v1/ticker/24hr");
    });

    if (!tickers || !Array.isArray(tickers)) {
        Log("[تحذير] فشل جلب بيانات الرموز، ستُستخدم القائمة القديمة.");
        return activeSymbols.length > 0 ? activeSymbols : [];
    }

    // تصفية الرموز: USDT فقط، ليست عملات مستقرة، عقود دائمة
    var futures = [];
    for (var i = 0; i < tickers.length; i++) {
        var t = tickers[i];
        var sym = t.symbol; // مثال: "BTCUSDT"

        // فقط رموز تنتهي بـ USDT
        if (!sym || sym.slice(-4) !== "USDT") {
            continue;
        }

        // استخراج الرمز الأساسي
        var base = sym.slice(0, -4);

        // استثناء العملات المستقرة
        var isStable = false;
        for (var s = 0; s < STABLE_COINS.length; s++) {
            if (base === STABLE_COINS[s]) {
                isStable = true;
                break;
            }
        }
        if (isStable) continue;

        var quoteVolume = parseFloat(t.quoteVolume) || 0;
        futures.push({
            symbol:      binanceToFmz(sym), // تحويل لصيغة FMZ
            binanceSym:  sym,
            volume:      quoteVolume
        });
    }

    // ترتيب تنازلي حسب حجم التداول
    futures.sort(function (a, b) { return b.volume - a.volume; });

    // أخذ أفضل TOP_SYMBOLS_COUNT رمز
    var top = [];
    var limit = Math.min(TOP_SYMBOLS_COUNT, futures.length);
    for (var j = 0; j < limit; j++) {
        top.push(futures[j].symbol);
    }

    Log("[رموز] تم تحميل", top.length, "رمزاً بنجاح.");
    return top;
}

 // تحديث قائمة الرموز إذا مضى أكثر من SYMBOL_REFRESH_HOURS ساعات
function maybeRefreshSymbols() {
    var now = Date.now();
    if (now - symbolsLastUpdated >= SYMBOL_REFRESH_HOURS * 3600 * 1000) {
        var fresh = fetchTopSymbols();
        if (fresh && fresh.length > 0) {
            activeSymbols      = fresh;
            symbolsLastUpdated = now;
        }
    }
}

// =====================================================================
// حساب المؤشرات التقنية — Technical Indicators
// =====================================================================

 // حساب VWAP يدوياً (FMZ لا تتضمن VWAP في مكتبة TA)
 // VWAP = Σ(TypicalPrice × Volume) / Σ(Volume)
 // السعر النموذجي = (High + Low + Close) / 3
 // نحسب VWAP تراكمياً على كامل مجموعة البيانات (كل يوم)
function calcVWAP(records) {
    var vwapArr = [];
    var cumTPV  = 0; // تراكم (السعر النموذجي × الحجم)
    var cumVol  = 0; // تراكم الحجم

    // تحديد بداية اليوم الأول لإعادة ضبط التراكم يومياً
    var dayStart = -1;

    for (var i = 0; i < records.length; i++) {
        var r  = records[i];
        var tp = (r.High + r.Low + r.Close) / 3; // السعر النموذجي

        // استخراج اليوم من الطابع الزمني (Unix ms -> UTC day)
        var day = Math.floor(r.Time / 86400000);

        // إعادة ضبط التراكم عند بداية يوم جديد
        if (day !== dayStart) {
            cumTPV   = 0;
            cumVol   = 0;
            dayStart = day;
        }

        cumTPV += tp * r.Volume;
        cumVol += r.Volume;

        vwapArr.push(cumVol > 0 ? cumTPV / cumVol : tp);
    }

    return vwapArr; // مصفوفة بنفس حجم records
}

 // حساب متوسط متحرك بسيط للحجم (SMA 20)
function calcVolSMA(records, period) {
    var result = [];
    for (var i = 0; i < records.length; i++) {
        if (i < period - 1) {
            result.push(NaN);
            continue;
        }
        var sum = 0;
        for (var j = i - period + 1; j <= i; j++) {
            sum += records[j].Volume;
        }
        result.push(sum / period);
    }
    return result;
}

// =====================================================================
// فحص شروط الإشارة الخمسة — Five-Condition Signal Check
// =====================================================================

 // فحص الشروط الخمسة على مجموعة الشمعات المغلقة:
 //   1. تقاطع EMA9 مع EMA21
 //   2. RSI(14) في النطاق المحدد
 //   3. السعر فوق/تحت VWAP
 //   4. ارتفاع الحجم أكثر من 1.5× المتوسط
 //   5. تقاطع خط MACD مع خط الإشارة (في آخر شمعتين)
 // يُعيد: "LONG" أو "SHORT" أو null
function checkSignal(records) {
    // نحتاج على الأقل 30 شمعة للحساب الموثوق
    if (!records || records.length < 30) return null;

    // استبعاد الشمعة الأخيرة (غير مغلقة بعد) — آخر عنصر
    var recs = records.slice(0, records.length - 1);
    var n    = recs.length;
    if (n < 30) return null;

    // ─────────────────────────────────────────────
    // حساب المؤشرات باستخدام مكتبة TA المدمجة في FMZ
    // ─────────────────────────────────────────────

    // EMA 9 و EMA 21
    var ema9Arr  = TA.EMA(recs, 9);
    var ema21Arr = TA.EMA(recs, 21);

    // RSI 14
    var rsiArr = TA.RSI(recs, 14);

    // MACD (12, 26, 9) — FMZ يُعيد [DIF[], DEA[], MACD[]]
    var macdResult = TA.MACD(recs, 12, 26, 9);
    var difArr  = macdResult[0]; // خط MACD الرئيسي (DIF)
    var deaArr  = macdResult[1]; // خط الإشارة (DEA / Signal)

    // VWAP (محسوب يدوياً)
    var vwapArr = calcVWAP(recs);

    // متوسط الحجم SMA20
    var volSMAArr = calcVolSMA(recs, 20);

    // ─────────────────────────────────────────────
    // قراءة القيم من الشمعتين الأخيرتين
    // cur = آخر شمعة مغلقة | prv = الشمعة قبلها
    // ─────────────────────────────────────────────
    var cur = recs[n - 1];
    var prv = recs[n - 2];

    var ema9Cur  = ema9Arr[n - 1];
    var ema9Prv  = ema9Arr[n - 2];
    var ema21Cur = ema21Arr[n - 1];
    var ema21Prv = ema21Arr[n - 2];
    var rsiCur   = rsiArr[n - 1];
    var vwapCur  = vwapArr[n - 1];
    var volSMA   = volSMAArr[n - 1];

    // قيم MACD لـ 3 شمعات أخيرة (للكشف عن التقاطع في آخر شمعتين)
    var difCur   = difArr[n - 1];
    var difPrv   = difArr[n - 2];
    var difPrv2  = difArr[n - 3];
    var deaCur   = deaArr[n - 1];
    var deaPrv   = deaArr[n - 2];
    var deaPrv2  = deaArr[n - 3];

    // التحقق من صحة القيم
    if (isNaN(ema9Cur) || isNaN(ema9Prv) || isNaN(ema21Cur) || isNaN(ema21Prv)) return null;
    if (isNaN(rsiCur)) return null;
    if (isNaN(vwapCur) || vwapCur === 0) return null;
    if (isNaN(volSMA) || volSMA === 0) return null;
    if (isNaN(difCur) || isNaN(deaCur) || isNaN(difPrv) || isNaN(deaPrv)) return null;

    // ─────────────────────────────────────────────
    // 1. شرط تقاطع EMA9 مع EMA21
    // ─────────────────────────────────────────────
    var emaCrossLong  = (ema9Prv < ema21Prv) && (ema9Cur > ema21Cur); // تقاطع صعودي
    var emaCrossShort = (ema9Prv > ema21Prv) && (ema9Cur < ema21Cur); // تقاطع هبوطي

    // ─────────────────────────────────────────────
    // 2. شرط RSI(14): نطاق 45-60 للشراء، 40-55 للبيع
    // ─────────────────────────────────────────────
    var rsiLong  = (rsiCur >= 45) && (rsiCur <= 60);
    var rsiShort = (rsiCur >= 40) && (rsiCur <= 55);

    // ─────────────────────────────────────────────
    // 3. شرط VWAP: السعر فوق VWAP للشراء، تحته للبيع
    // ─────────────────────────────────────────────
    var closeCur   = cur.Close;
    var vwapLong   = closeCur > vwapCur;
    var vwapShort  = closeCur < vwapCur;

    // ─────────────────────────────────────────────
    // 4. شرط ارتفاع الحجم: أكبر من 1.5× المتوسط
    // ─────────────────────────────────────────────
    var volSpike = cur.Volume > (1.5 * volSMA);

    // ─────────────────────────────────────────────
    // 5. شرط تقاطع MACD مع خط الإشارة (في آخر شمعتين)
    // ─────────────────────────────────────────────
    // تقاطع صعودي: DIF يعبر فوق DEA
    var macdCrossAbove1 = (!isNaN(difPrv2) && !isNaN(deaPrv2)) && (difPrv2 < deaPrv2) && (difPrv > deaPrv);
    var macdCrossAbove2 = (difPrv < deaPrv) && (difCur > deaCur);
    var macdCrossLong   = macdCrossAbove1 || macdCrossAbove2;

    // تقاطع هبوطي: DIF يعبر تحت DEA
    var macdCrossBelow1 = (!isNaN(difPrv2) && !isNaN(deaPrv2)) && (difPrv2 > deaPrv2) && (difPrv < deaPrv);
    var macdCrossBelow2 = (difPrv > deaPrv) && (difCur < deaCur);
    var macdCrossShort  = macdCrossBelow1 || macdCrossBelow2;

    // ─────────────────────────────────────────────
    // تقييم الإشارة النهائية — يجب تحقق جميع الشروط الخمسة
    // ─────────────────────────────────────────────
    if (emaCrossLong && rsiLong && vwapLong && volSpike && macdCrossLong) {
        return "LONG";
    }
    if (emaCrossShort && rsiShort && vwapShort && volSpike && macdCrossShort) {
        return "SHORT";
    }
    return null;
}

// =====================================================================
// دورة مسح الرموز — Symbol Scanning Cycle
// =====================================================================

 // مسح جميع الرموز النشطة للبحث عن إشارات صالحة
 // يُعيد: كائن الإشارة الأفضل (الأعلى حجماً) أو null إذا لا توجد إشارات
function scanSymbols() {
    var now = new Date();
    Log("\n[مسح] بدء مسح", activeSymbols.length, "رمزاً...",
        now.getUTCHours() + ":" + now.getUTCMinutes() + " UTC");

    var candidates = []; // قائمة الإشارات المحتملة

    for (var i = 0; i < activeSymbols.length; i++) {
        var fmzSym = activeSymbols[i];

        try {
            // تحديد الرمز في FMZ
            exchange.SetContractType(fmzSym);

            // جلب الشمعات (الحد + 1 لاستبعاد الشمعة الحالية غير المغلقة)
            var records = exchange.GetRecords(TIMEFRAME);
            if (!records || records.length < 50) {
                Sleep(SYMBOL_DELAY_MS);
                continue;
            }

            // تحليل الإشارة
            var signal = checkSignal(records);

            if (signal) {
                // جلب حجم التداول من المؤشر الحالي
                var ticker = exchange.GetTicker();
                var vol    = ticker ? (ticker.Volume || 0) : 0;
                var price  = records[records.length - 2].Close; // آخر شمعة مغلقة

                candidates.push({
                    symbol:    fmzSym,
                    direction: signal,
                    volume:    vol,
                    price:     price
                });

                Log("[إشارة]", fmzSym, "→", signal,
                    "| حجم:", vol.toFixed(0));
            }

        } catch (e) {
            // تجاهل الرموز التي تُسبب خطأ (ربما غير متوفرة)
            // Log("[تحذير] خطأ في", fmzSym, ":", e.message);
        }

        Sleep(SYMBOL_DELAY_MS);
    }

    if (candidates.length === 0) {
        return null;
    }

    // اختيار الإشارة ذات أعلى حجم تداول
    var best = candidates[0];
    for (var k = 1; k < candidates.length; k++) {
        if (candidates[k].volume > best.volume) {
            best = candidates[k];
        }
    }

    Log("[اختيار] أفضل إشارة:", best.symbol, best.direction);
    return best;
}

// =====================================================================
// الحصول على دقة الكمية — Get Amount Precision
// =====================================================================

 // تقريب القيمة للأسفل بعدد المنازل العشرية المحددة
 // لتجنب رفض الأمر بسبب الدقة الزائدة
function floorTo(value, decimals) {
    var factor = Math.pow(10, decimals);
    return Math.floor(value * factor) / factor;
}

 // الحصول على الحد الأدنى للكمية والخطوة من Binance Futures
 // يستخدم /fapi/v1/exchangeInfo
function getSymbolStepSize(binanceSym) {
    try {
        var info = exchange.IO("api", "GET", "/fapi/v1/exchangeInfo");
        if (!info || !info.symbols) return { stepSize: 0.001, pricePrecision: 2 };

        for (var i = 0; i < info.symbols.length; i++) {
            var s = info.symbols[i];
            if (s.symbol === binanceSym) {
                var stepSize       = 0.001;
                var pricePrecision = s.pricePrecision || 2;

                // البحث في فلاتر الرمز عن LOT_SIZE
                if (s.filters) {
                    for (var j = 0; j < s.filters.length; j++) {
                        if (s.filters[j].filterType === "LOT_SIZE") {
                            stepSize = parseFloat(s.filters[j].stepSize) || 0.001;
                            break;
                        }
                    }
                }
                return { stepSize: stepSize, pricePrecision: pricePrecision };
            }
        }
    } catch (e) {
        Log("[تحذير] فشل جلب معلومات الرمز:", e.message);
    }
    return { stepSize: 0.001, pricePrecision: 2 };
}

 // حساب عدد المنازل العشرية من قيمة stepSize
 // مثال: 0.001 -> 3 | 0.01 -> 2 | 1 -> 0
function getDecimals(stepSize) {
    if (stepSize >= 1) return 0;
    var s = stepSize.toString();
    var dotIndex = s.indexOf(".");
    if (dotIndex === -1) return 0;
    return s.length - dotIndex - 1;
}

// =====================================================================
// وضع أوامر TP و SL عبر Binance API — Place TP/SL Orders via API
// =====================================================================

 // وضع أمر TAKE_PROFIT_MARKET عبر Binance Futures API مباشرة
 // يُعيد معرف الأمر أو null عند الفشل
function placeTakeProfitOrder(binanceSym, side, stopPrice) {
    try {
        var result = exchange.IO("api", "POST", "/fapi/v1/order",
            "symbol=" + binanceSym +
            "&side=" + side +
            "&type=TAKE_PROFIT_MARKET" +
            "&stopPrice=" + stopPrice +
            "&closePosition=true" +
            "&workingType=CONTRACT_PRICE" +
            "&timeInForce=GTE_GTC"
        );
        if (result && result.orderId) {
            Log("[TP] تم وضع أمر Take Profit: #" + result.orderId +
                " عند $" + stopPrice);
            return result.orderId;
        }
    } catch (e) {
        Log("[خطأ] فشل وضع TP:", e.message || e);
    }
    return null;
}

 // وضع أمر STOP_MARKET عبر Binance Futures API مباشرة
 // يُعيد معرف الأمر أو null عند الفشل
function placeStopLossOrder(binanceSym, side, stopPrice) {
    try {
        var result = exchange.IO("api", "POST", "/fapi/v1/order",
            "symbol=" + binanceSym +
            "&side=" + side +
            "&type=STOP_MARKET" +
            "&stopPrice=" + stopPrice +
            "&closePosition=true" +
            "&workingType=CONTRACT_PRICE" +
            "&timeInForce=GTE_GTC"
        );
        if (result && result.orderId) {
            Log("[SL] تم وضع أمر Stop Loss: #" + result.orderId +
                " عند $" + stopPrice);
            return result.orderId;
        }
    } catch (e) {
        Log("[خطأ] فشل وضع SL:", e.message || e);
    }
    return null;
}

 // إلغاء أمر محدد عبر Binance Futures API
function cancelOrderById(binanceSym, orderId) {
    if (!orderId) return;
    try {
        exchange.IO("api", "DELETE", "/fapi/v1/order",
            "symbol=" + binanceSym + "&orderId=" + orderId
        );
        Log("[إلغاء] تم إلغاء الأمر #" + orderId);
    } catch (e) {
        Log("[تحذير] فشل إلغاء الأمر #" + orderId + ":", e.message || e);
    }
}

 // إلغاء أوامر TP و SL المعلقة للصفقة الحالية
function cancelTpSl() {
    if (!currentTrade) return;
    var binSym = fmzToBinance(currentTrade.symbol);
    cancelOrderById(binSym, currentTrade.tpOrderId);
    cancelOrderById(binSym, currentTrade.slOrderId);
    currentTrade.tpOrderId = null;
    currentTrade.slOrderId = null;
}

// =====================================================================
// تعيين الرافعة المالية — Set Leverage
// =====================================================================

 // تعيين الرافعة المالية لرمز معين عبر Binance API
 // يُعيد true عند النجاح، false عند الفشل
function setLeverage(binanceSym, leverage) {
    try {
        exchange.IO("api", "POST", "/fapi/v1/leverage",
            "symbol=" + binanceSym + "&leverage=" + leverage
        );
        return true;
    } catch (e) {
        Log("[تحذير] فشل تعيين الرافعة لـ", binanceSym, ":", e.message || e);
        return false;
    }
}

 // تعيين وضع الهامش المعزول (Isolated) لرمز معين
function setIsolatedMargin(binanceSym) {
    try {
        exchange.IO("api", "POST", "/fapi/v1/marginType",
            "symbol=" + binanceSym + "&marginType=ISOLATED"
        );
    } catch (e) {
        // بعض الأخطاء طبيعية إذا كان الوضع محدداً مسبقاً
        var msg = e.message || e.toString();
        if (msg.indexOf("already") === -1 && msg.indexOf("No need") === -1) {
            Log("[تحذير] نوع الهامش:", msg);
        }
    }
}

// =====================================================================
// تنفيذ الصفقة — Trade Execution
// =====================================================================

 // تنفيذ الصفقة كاملةً:
 //   1. تعيين الرافعة ونوع الهامش
 //   2. جلب الرصيد وحساب حجم المركز (مضاعفة كاملة)
 //   3. تنفيذ أمر سوق
 //   4. وضع أوامر TP و SL
 // يُعيد true عند النجاح، false عند الفشل
function executeTrade(signal) {
    var fmzSym  = signal.symbol;
    var dir     = signal.direction; // "LONG" أو "SHORT"
    var binSym  = fmzToBinance(fmzSym);

    Log("\n[تنفيذ] بدء تنفيذ صفقة", dir, "على", fmzSym);

    // ────────────────────────────────────────
    // 1. تعيين الرمز في FMZ
    // ────────────────────────────────────────
    try {
        exchange.SetContractType(fmzSym);
    } catch (e) {
        Log("[خطأ] فشل تعيين الرمز:", fmzSym, e.message);
        return false;
    }

    // ────────────────────────────────────────
    // 2. تعيين الرافعة ونوع الهامش
    // ────────────────────────────────────────
    if (!setLeverage(binSym, LEVERAGE)) {
        return false;
    }
    setIsolatedMargin(binSym);

    // ────────────────────────────────────────
    // 3. جلب الرصيد المتاح
    // ────────────────────────────────────────
    var account = retryCall(function () { return exchange.GetAccount(); });
    if (!account) {
        Log("[خطأ] فشل جلب الرصيد.");
        return false;
    }

    // في FMZ للعقود الآجلة: Balance = الرصيد المتاح بالـ USDT
    var freeUsdt = account.Balance;
    if (freeUsdt < MIN_BALANCE) {
        Log("[تحذير حرج] الرصيد $" + freeUsdt.toFixed(2) +
            " أقل من الحد الأدنى $" + MIN_BALANCE + "!");
        return false;
    }

    // ────────────────────────────────────────
    // 4. جلب السعر الحالي وحساب الحجم
    // ────────────────────────────────────────
    var ticker = retryCall(function () { return exchange.GetTicker(); });
    if (!ticker) {
        Log("[خطأ] فشل جلب السعر.");
        return false;
    }
    var entryEstimate = ticker.Last;

    // جلب معلومات دقة الرمز
    var symInfo    = getSymbolStepSize(binSym);
    var stepSize   = symInfo.stepSize;
    var priceDec   = symInfo.pricePrecision;
    var amountDec  = getDecimals(stepSize);

    // حساب حجم المركز: (الرصيد × الرافعة) / السعر — مضاعفة كاملة
    var rawSize  = (freeUsdt * LEVERAGE) / entryEstimate;
    var size     = floorTo(rawSize, amountDec);

    // تأكد أن الحجم لا يقل عن stepSize
    if (size < stepSize || size <= 0) {
        Log("[خطأ] حجم المركز صفر أو أقل من الحد الأدنى:", size, "| stepSize:", stepSize);
        return false;
    }

    Log("[حجم] الرصيد: $" + freeUsdt.toFixed(2) +
        " | حجم المركز: " + size + " @ ~$" + entryEstimate.toFixed(4));

    // ────────────────────────────────────────
    // 5. تنفيذ أمر السوق عبر FMZ
    // ────────────────────────────────────────
    var orderId = null;
    try {
        if (dir === "LONG") {
            // فتح مركز شراء (Long)
            exchange.SetDirection("buy");
            orderId = exchange.Buy(-1, size); // -1 = أمر سوق
        } else {
            // فتح مركز بيع (Short)
            exchange.SetDirection("sell");
            orderId = exchange.Sell(-1, size); // -1 = أمر سوق
        }
    } catch (e) {
        Log("[خطأ] فشل تنفيذ أمر السوق:", e.message || e);
        return false;
    }

    if (!orderId) {
        Log("[خطأ] لم يُعاد معرف الأمر — الأمر فشل.");
        return false;
    }

    // انتظار ثانية للحصول على سعر التنفيذ الفعلي
    Sleep(1000);

    // جلب سعر التنفيذ الفعلي
    var fillPrice = entryEstimate;
    try {
        var orderInfo = exchange.GetOrder(orderId);
        if (orderInfo && orderInfo.AvgPrice && orderInfo.AvgPrice > 0) {
            fillPrice = orderInfo.AvgPrice;
        } else if (orderInfo && orderInfo.Price && orderInfo.Price > 0) {
            fillPrice = orderInfo.Price;
        }
    } catch (e) {
        Log("[تحذير] استخدام السعر التقديري: $" + fillPrice.toFixed(6));
    }

    Log("[تنفيذ] تم التنفيذ بسعر: $" + fillPrice.toFixed(6));

    // ────────────────────────────────────────
    // 6. حساب أسعار TP و SL
    // ────────────────────────────────────────
    var tpPrice, slPrice;
    var priceFactor = Math.pow(10, priceDec);

    if (dir === "LONG") {
        tpPrice = Math.round(fillPrice * TP_PCT_LONG  * priceFactor) / priceFactor;
        slPrice = Math.round(fillPrice * SL_PCT_LONG  * priceFactor) / priceFactor;
    } else {
        tpPrice = Math.round(fillPrice * TP_PCT_SHORT * priceFactor) / priceFactor;
        slPrice = Math.round(fillPrice * SL_PCT_SHORT * priceFactor) / priceFactor;
    }

    Log("[أهداف] TP: $" + tpPrice.toFixed(priceDec) +
        " | SL: $" + slPrice.toFixed(priceDec));

    // ────────────────────────────────────────
    // 7. وضع أوامر TP و SL عبر Binance API
    // ────────────────────────────────────────
    var closeSide = (dir === "LONG") ? "SELL" : "BUY";

    var tpOrderId = placeTakeProfitOrder(binSym, closeSide, tpPrice.toFixed(priceDec));
    var slOrderId = placeStopLossOrder  (binSym, closeSide, slPrice.toFixed(priceDec));

    // ────────────────────────────────────────
    // 8. حفظ معلومات الصفقة في المتغير العالمي
    // ────────────────────────────────────────
    currentTrade = {
        symbol:     fmzSym,
        direction:  dir,
        size:       size,
        entryPrice: fillPrice,
        tpPrice:    tpPrice,
        slPrice:    slPrice,
        tpOrderId:  tpOrderId,
        slOrderId:  slOrderId,
        entryTime:  Date.now(),
        open:       true
    };

    return true;
}

// =====================================================================
// فحص حالة المركز — Check Position Status
// =====================================================================

 // التحقق من أن المركز لا يزال مفتوحاً
 // يُعيد true إذا كان المركز مفتوحاً، false إذا أُغلق
function isPositionOpen() {
    try {
        var positions = exchange.GetPosition();
        if (!positions || positions.length === 0) return false;

        var fmzSym = currentTrade.symbol;
        for (var i = 0; i < positions.length; i++) {
            var pos = positions[i];
            // FMZ يُعيد ContractType للعقود الآجلة
            if (pos.ContractType === fmzSym && Math.abs(pos.Amount) > 0) {
                return true;
            }
        }
        return false;
    } catch (e) {
        // في حالة الشك، نفترض أن المركز مفتوح
        return true;
    }
}

 // جلب السعر الحالي للرمز النشط
function getCurrentPrice() {
    var ticker = retryCall(function () { return exchange.GetTicker(); });
    return ticker ? ticker.Last : 0;
}

 // إغلاق المركز المفتوح بأمر سوق (للتايم-أوت أو الإيقاف الطارئ)
function closePositionMarket() {
    if (!currentTrade) return;

    var dir  = currentTrade.direction;
    var size = currentTrade.size;

    if (!size || size <= 0) return;

    try {
        if (dir === "LONG") {
            // إغلاق مركز شراء: نبيع
            exchange.SetDirection("closebuy");
            exchange.Sell(-1, size);
        } else {
            // إغلاق مركز بيع: نشتري
            exchange.SetDirection("closesell");
            exchange.Buy(-1, size);
        }
        Log("[إغلاق] تم إغلاق المركز بأمر سوق على", currentTrade.symbol);
    } catch (e) {
        Log("[خطأ] فشل إغلاق المركز:", e.message || e);
    }
}

// =====================================================================
// مراقبة الصفقة — Trade Monitoring
// =====================================================================

 // مراقبة الصفقة المفتوحة حتى إغلاقها بأحد الأسباب:
 //   - TP  : وصل السعر لهدف الربح
 //   - SL  : وصل السعر لوقف الخسارة
 //   - TIMEOUT: تجاوزت الصفقة MAX_TRADE_MINUTES دقيقة
 // بعد الإغلاق: يُحدث الإحصائيات ويطبع النتيجة ويُسجّل الربح في FMZ
function monitorTrade() {
    if (!currentTrade) return;

    var symbol      = currentTrade.symbol;
    var dir         = currentTrade.direction;
    var entryPrice  = currentTrade.entryPrice;
    var tpPrice     = currentTrade.tpPrice;
    var slPrice     = currentTrade.slPrice;
    var entryTime   = currentTrade.entryTime;
    var maxMs       = MAX_TRADE_MINUTES * 60 * 1000; // بالميلي ثانية

    var closeReason = "TIMEOUT";
    var closePrice  = entryPrice;

    Log("\n[مراقبة] مراقبة صفقة", dir, "على", symbol);
    Log("[مراقبة] سعر الدخول: $" + entryPrice.toFixed(6) +
        " | TP: $" + tpPrice.toFixed(6) +
        " | SL: $" + slPrice.toFixed(6));

    // تأكيد الرمز في FMZ قبل المراقبة
    try { exchange.SetContractType(symbol); } catch (e) {}

    // ─────────────────────────────────────────
    // حلقة المراقبة — تستمر حتى الإغلاق
    // ─────────────────────────────────────────
    while (true) {
        var elapsed = Date.now() - entryTime;

        // ── فحص انتهاء الوقت (20 دقيقة) ──
        if (elapsed >= maxMs) {
            Log("[انتهاء الوقت] تجاوزت الصفقة " + MAX_TRADE_MINUTES + " دقيقة — جاري الإغلاق...");
            cancelTpSl();
            closePositionMarket();
            closePrice  = getCurrentPrice();
            closeReason = "TIMEOUT";
            break;
        }

        // ── فحص حالة المركز ──
        var posOpen = isPositionOpen();
        if (!posOpen) {
            // المركز أُغلق بواسطة TP أو SL تلقائياً
            var curPrice = getCurrentPrice();

            // تحديد سبب الإغلاق بناءً على الاتجاه والسعر
            if (dir === "LONG") {
                if (curPrice >= tpPrice * 0.999) {
                    closeReason = "TP";
                    closePrice  = tpPrice;
                } else {
                    closeReason = "SL";
                    closePrice  = slPrice;
                }
            } else {
                if (curPrice <= tpPrice * 1.001) {
                    closeReason = "TP";
                    closePrice  = tpPrice;
                } else {
                    closeReason = "SL";
                    closePrice  = slPrice;
                }
            }

            // إلغاء أي أوامر متبقية
            cancelTpSl();
            Log("[إغلاق] الصفقة أُغلقت بواسطة: " + closeReason +
                " | السعر: $" + closePrice.toFixed(6));
            break;
        }

        // ── طباعة حالة الصفقة ──
        var remaining = maxMs - elapsed;
        var mins = Math.floor(remaining / 60000);
        var secs = Math.floor((remaining % 60000) / 1000);
        var curP = getCurrentPrice();
        Log("[مراقبة] السعر الحالي: $" + curP.toFixed(6) +
            " | الوقت المتبقي: " + mins + "د " + secs + "ث");

        Sleep(POSITION_POLL_MS);
    }

    // ─────────────────────────────────────────
    // حساب الأرباح والخسائر — PnL Calculation
    // ─────────────────────────────────────────
    var pnlPct;
    if (dir === "LONG") {
        pnlPct = (closePrice - entryPrice) / entryPrice;
    } else {
        pnlPct = (entryPrice - closePrice) / entryPrice;
    }

    var pnlUsdt = pnlPct * currentTrade.size * entryPrice;

    // تحديث الإحصائيات
    stats.totalTrades += 1;
    stats.totalPnl    += pnlUsdt;

    if (closeReason === "TP") {
        stats.wins += 1;
    } else if (closeReason === "SL") {
        stats.losses += 1;
    } else {
        stats.timeouts += 1;
    }

    // جلب الرصيد المحدّث من FMZ
    var accountUpdated = retryCall(function () { return exchange.GetAccount(); });
    if (accountUpdated) {
        // Balance + FrozenBalance = إجمالي الرصيد
        stats.balance = (accountUpdated.Balance || 0) +
                        (accountUpdated.FrozenBalance || 0);
    } else {
        stats.balance += pnlUsdt;
    }

    var pnlSign = pnlUsdt >= 0 ? "+" : "";
    Log("\n══════════════════════════════════════");
    Log("[نتيجة] سبب الإغلاق  :", closeReason);
    Log("[نتيجة] ربح/خسارة    :", pnlSign + pnlUsdt.toFixed(4) + " USDT",
        "(" + pnlSign + (pnlPct * 100).toFixed(4) + "%)");
    Log("[نتيجة] الرصيد الجديد: $" + stats.balance.toFixed(2));
    Log("══════════════════════════════════════\n");

    // تسجيل الربح في منصة FMZ (يُظهر في الرسم البياني للأداء)
    LogProfit(stats.balance);

    // إعادة تعيين حالة الصفقة
    currentTrade = null;

    // طباعة اللوحة بعد كل صفقة
    printDashboard();
}

// =====================================================================
// لوحة التحكم — Dashboard
// =====================================================================

 // طباعة لوحة تحكم كاملة في سجل FMZ
 // تُطبع بعد كل صفقة وكل DASHBOARD_INTERVAL ميلي ثانية
function printDashboard() {
    lastDashboardPrint = Date.now();

    var total    = stats.totalTrades;
    var wins     = stats.wins;
    var losses   = stats.losses;
    var timeouts = stats.timeouts;
    var balance  = stats.balance;
    var totalPnl = stats.totalPnl;

    var pnlPctTotal = INITIAL_CAPITAL > 0
        ? ((balance - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100)
        : 0;

    var winPct  = total > 0 ? (wins   / total * 100) : 0;
    var lossPct = total > 0 ? (losses / total * 100) : 0;

    var inTrade    = currentTrade !== null;
    var status     = inTrade ? "IN TRADE" : "SCANNING";
    var symDisp    = inTrade ? currentTrade.symbol    : "---";
    var dirDisp    = inTrade ? currentTrade.direction : "---";
    var entryDisp  = inTrade ? "$" + currentTrade.entryPrice.toFixed(2) : "---";
    var tpDisp     = inTrade ? "$" + currentTrade.tpPrice.toFixed(2) + " (+2.0%)" : "---";
    var slDisp     = inTrade ? "$" + currentTrade.slPrice.toFixed(2) + " (-0.7%)" : "---";

    var timeDisp = "---";
    if (inTrade) {
        var elapsed   = Date.now() - currentTrade.entryTime;
        var remaining = Math.max(0, MAX_TRADE_MINUTES * 60000 - elapsed);
        var rMin = Math.floor(remaining / 60000);
        var rSec = Math.floor((remaining % 60000) / 1000);
        timeDisp = rMin + " دقيقة " + rSec + " ثانية";
    }

    var pnlSign = totalPnl >= 0 ? "+" : "";

    Log("╔══════════════════════════════════════════════╗");
    Log("║        🔪 THE SURGEON BOT — LIVE             ║");
    Log("╠══════════════════════════════════════════════╣");
    Log("║  الرصيد الحالي      : $" + balance.toFixed(2) + " USDT");
    Log("║  رأس المال الأولي   : $" + INITIAL_CAPITAL.toFixed(2));
    Log("║  إجمالي الربح/خسارة : " + pnlSign + "$" + totalPnl.toFixed(2) +
        "  (" + pnlSign + pnlPctTotal.toFixed(2) + "%)");
    Log("╠══════════════════════════════════════════════╣");
    Log("║  إجمالي الصفقات     :", total);
    Log("║  صفقات رابحة        :", wins, " (" + winPct.toFixed(1) + "%)");
    Log("║  صفقات خاسرة        :", losses, " (" + lossPct.toFixed(1) + "%)");
    Log("║  إغلاق بالوقت       :", timeouts);
    Log("╠══════════════════════════════════════════════╣");
    Log("║  الحالة             :", status);
    Log("║  الرمز الحالي       :", symDisp);
    Log("║  الاتجاه            :", dirDisp);
    Log("║  سعر الدخول         :", entryDisp);
    Log("║  هدف الربح          :", tpDisp);
    Log("║  وقف الخسارة        :", slDisp);
    Log("║  الوقت المتبقي      :", timeDisp);
    Log("║  الرموز المراقبة    :", activeSymbols.length);
    Log("╚══════════════════════════════════════════════╝");
}

// =====================================================================
// لافتة الإطلاق — Startup Banner
// =====================================================================

 // طباعة لافتة البداية مع معلومات التهيئة
function printBanner() {
    Log("╔══════════════════════════════════════════════════════╗");
    Log("║          🔪 THE SURGEON BOT — جراح العملات          ║");
    Log("║          Binance Futures Scalping Bot — FMZ Quant    ║");
    Log("╠══════════════════════════════════════════════════════╣");
    Log("║  المنصة            : FMZ Quant (fmz.com)");
    Log("║  البورصة           : Binance USDT-M Futures");
    Log("║  رأس المال الأولي  : $" + INITIAL_CAPITAL);
    Log("║  الرافعة المالية   : " + LEVERAGE + "x");
    Log("║  الإطار الزمني     : 5 دقائق");
    Log("║  الهدف             : +2.0% | وقف الخسارة: -0.7%");
    Log("║  مدة الصفقة القصوى : " + MAX_TRADE_MINUTES + " دقيقة");
    Log("║  عدد الرموز المراقبة: " + TOP_SYMBOLS_COUNT);
    Log("╚══════════════════════════════════════════════════════╝");
}

// =====================================================================
// الحلقة الرئيسية — Main Loop (نقطة الدخول في FMZ)
// =====================================================================

 // الدالة الرئيسية — يستدعيها FMZ تلقائياً عند تشغيل الاستراتيجية
 // تعمل في حلقة لانهائية حتى يوقفها المستخدم من لوحة FMZ
function main() {
    // ─── طباعة اللافتة ───
    printBanner();

    // ─── التحقق من صحة الإعدادات ───
    if (LEVERAGE < 1 || LEVERAGE > 125) {
        Log("[خطأ] الرافعة المالية يجب أن تكون بين 1 و 125!");
        return;
    }

    // ─── جلب الرصيد الأولي ───
    Log("[اتصال] جاري الاتصال ببينانس فيوتشرز...");
    var account = retryCall(function () { return exchange.GetAccount(); });
    if (account) {
        var actualBalance = (account.Balance || 0) + (account.FrozenBalance || 0);
        if (actualBalance > 0) {
            stats.balance = actualBalance;
        }
        Log("[رصيد] الرصيد الحالي: $" + stats.balance.toFixed(2) + " USDT");
    } else {
        Log("[تحذير] فشل جلب الرصيد — سيُستخدم رأس المال الأولي: $" + INITIAL_CAPITAL);
    }

    // ─── تحميل قائمة الرموز الأولية ───
    Log("[تهيئة] جاري تحميل قائمة الرموز...");
    activeSymbols      = fetchTopSymbols();
    symbolsLastUpdated = Date.now();

    if (!activeSymbols || activeSymbols.length === 0) {
        Log("[خطأ فادح] فشل تحميل قائمة الرموز! تأكد من الاتصال بالبورصة.");
        return;
    }

    Log("[جاهز] تم تحميل " + activeSymbols.length + " رمزاً. البوت يعمل الآن!");
    printDashboard();

    // ─── الحلقة الرئيسية اللانهائية ───
    while (true) {

        // ── تحديث قائمة الرموز كل 4 ساعات ──
        maybeRefreshSymbols();

        // ── فحص الرصيد الحرج ──
        var accCheck = retryCall(function () { return exchange.GetAccount(); });
        if (accCheck) {
            var freeBalance = accCheck.Balance || 0;
            stats.balance   = freeBalance + (accCheck.FrozenBalance || 0);

            if (freeBalance < MIN_BALANCE) {
                Log("\n[تحذير حرج] ⚠️  الرصيد المتاح $" + freeBalance.toFixed(2) +
                    " أقل من الحد الأدنى $" + MIN_BALANCE + "!");
                Log("[إيقاف] تم إيقاف التداول بسبب انخفاض الرصيد.");
                printDashboard();
                break; // إيقاف الحلقة — سيوقف FMZ الاستراتيجية
            }
        }

        // ── إذا لا توجد صفقة مفتوحة، ابحث عن إشارة ──
        if (!currentTrade) {
            var signal = scanSymbols();

            if (signal) {
                // محاولة تنفيذ الصفقة
                var success = executeTrade(signal);

                if (success) {
                    // مراقبة الصفقة حتى إغلاقها (TP / SL / TIMEOUT)
                    monitorTrade();
                } else {
                    Log("[تحذير] فشل تنفيذ الصفقة على", signal.symbol);
                    Sleep(5000);
                }

            } else {
                Log("[مسح] لم يُعثر على إشارات — الانتظار " +
                    (SCAN_INTERVAL_MS / 1000) + " ثانية...");

                // طباعة اللوحة كل DASHBOARD_INTERVAL
                if (Date.now() - lastDashboardPrint >= DASHBOARD_INTERVAL) {
                    printDashboard();
                }

                Sleep(SCAN_INTERVAL_MS);
            }

        } else {
            // في حال غير متوقع — استئناف مراقبة الصفقة القائمة
            Log("[استئناف] استئناف مراقبة صفقة قائمة على", currentTrade.symbol);

            // تأكيد تعيين الرمز
            try { exchange.SetContractType(currentTrade.symbol); } catch (e) {}

            monitorTrade();
        }
    }

    Log("[إيقاف] تم إيقاف البوت.");
    printDashboard();
}
