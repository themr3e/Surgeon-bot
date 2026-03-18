/*
+==============================================================+
|          THE SURGEON BOT -- FMZ QUANT EDITION               |
|          Binance Futures USDT-M Perpetual Scalping Bot       |
+==============================================================+

Full scalping strategy for Binance USDT-M Perpetual Futures
Running on FMZ Quant platform (fmz.com)

Logic:
  - Scan top 200 symbols by 24h trading volume
  - 5 entry conditions: EMA cross, RSI, VWAP, volume spike, MACD position
  - Take Profit: 2% | Stop Loss: 0.7% | Max trade duration: 20 minutes
  - Full compounding of capital

FMZ functions used:
  exchange.GetRecords()      — fetch candles
  exchange.GetTicker()       — fetch current price
  exchange.IO("currency", sym) + exchange.SetContractType("swap") — set symbol
  exchange.Buy()             — buy order
  exchange.Sell()            — sell order
  exchange.GetAccount()      — fetch balance
  exchange.GetPosition()     — fetch open positions
  exchange.IO()              — direct Binance API call
*/

// =====================================================================
// Main Configuration
// Can be changed from FMZ dashboard via strategy parameters
// =====================================================================
var TESTNET              = true;        // Set true when using Binance Futures Testnet
var INITIAL_CAPITAL      = 500;         // Initial capital in USD
var TOP_SYMBOLS_COUNT    = 200;         // Number of top symbols by volume (ignored on testnet)
var TIMEFRAME            = PERIOD_M5;  // Timeframe (5 minutes)
var CANDLES_LIMIT        = 201;        // +1 to exclude unclosed candle
var LEVERAGE             = 10;         // Leverage
var RISK_PER_TRADE_PCT   = 0.02;       // Risk 2% of balance per trade
var MAX_ORDER_USDT       = 200;        // Hard cap: never put more than $200 into one trade
var TP_PCT_LONG          = 1.020;      // Take profit for long  (+2%)
var TP_PCT_SHORT         = 0.980;      // Take profit for short (-2%)
var SL_PCT_LONG          = 0.993;      // Stop loss for long    (-0.7%)
var SL_PCT_SHORT         = 1.007;      // Stop loss for short   (+0.7%)
var MAX_TRADE_MINUTES    = 20;         // Max trade duration in minutes
var SCAN_INTERVAL_MS     = 30000;      // Scan interval in ms (30 seconds)
var SYMBOL_DELAY_MS      = 200;        // Delay between symbols to avoid rate limit
var POSITION_POLL_MS     = 10000;      // Poll position every 10 seconds
var MAX_DAILY_LOSS       = 50;         // Max cumulative realized loss (SL trades only) before stopping
var SYMBOL_REFRESH_HOURS = 4;          // Refresh symbol list every 4 hours
var DASHBOARD_INTERVAL   = 300000;     // Print dashboard every 5 minutes (ms)
var USE_MARKET_BIAS      = true;       // Enable/disable 200 EMA daily market bias filter
var TELEGRAM_TOKEN      = "8756049447:AAHAiLLFFaNF6ifw5ybEKAcT0TmRYtDhOW0";
var TELEGRAM_CHAT_ID    = "8724850558";
var TELEGRAM_NOTIFY_MS  = 3600000;     // 1 hour in milliseconds

// =====================================================================
// Excluded Stablecoins
// =====================================================================
var STABLE_COINS = ["USDC", "BUSD", "TUSD", "USDP", "DAI", "FDUSD", "USDT"];

// =====================================================================
// Global State Variables
// =====================================================================
var activeSymbols       = [];    // Active symbol list (FMZ format: "BTC_USDT")
var symbolsLastUpdated  = 0;     // Timestamp of last symbol list update (ms)
var currentTrade        = null;  // Current trade data or null if no open trade

// Performance statistics
var stats = {
    balance:      INITIAL_CAPITAL,
    totalTrades:  0,
    wins:         0,
    losses:       0,
    timeouts:     0,
    totalPnl:     0.0,
    realizedLoss: 0.0   // cumulative loss from SL-closed trades this session
};

var lastDashboardPrint = 0;   // Timestamp of last dashboard print
var lastTelegramTime   = 0;   // Timestamp of last hourly notification
var hourlyLogBuffer    = {};  // stores log message counts for hourly summary

// =====================================================================
// Symbol Format Conversion
// FMZ uses: "BTC_USDT"  |  Binance API uses: "BTCUSDT"
// =====================================================================

 // Convert Binance API format to FMZ format
 // Example: "BTCUSDT" -> "BTC_USDT"
function binanceToFmz(binanceSymbol) {
    if (binanceSymbol.slice(-4) === "USDT") {
        var base = binanceSymbol.slice(0, -4); // remove last 4 chars "USDT"
        return base + "_USDT";
    }
    return binanceSymbol;
}

 // Convert FMZ format to Binance API format
 // Example: "BTC_USDT" -> "BTCUSDT"
function fmzToBinance(fmzSymbol) {
    return fmzSymbol.replace("_", "");
}

// =====================================================================
// API Call with Retry
// =====================================================================

 // Execute a function with up to 3 retries on failure
 // Accepts a function (fn) and runs it until success or retries exhausted
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
            Log("[WARN] Attempt", attempt, "/", maxRetries, "failed:", e.message || e);
        }
        if (attempt < maxRetries) {
            Sleep(delayMs);
        }
    }
    return null;
}

// =====================================================================
// Fetch Top 200 Symbols by Volume
// =====================================================================

 // Fetch 24h data for all Binance Futures symbols
 // Filter and sort by trading volume, return top TOP_SYMBOLS_COUNT symbols
 // Uses Binance Futures REST API directly via exchange.IO
function fetchTopSymbols() {
    Log("[SYMBOLS] Refreshing symbol list...");

    var tickers = retryCall(function () {
        return exchange.IO("api", "GET", "/fapi/v1/ticker/24hr");
    });

    if (!tickers || !Array.isArray(tickers)) {
        Log("[WARN] Failed to fetch symbol data. Response:", JSON.stringify(tickers).slice(0, 200));
        return activeSymbols.length > 0 ? activeSymbols : [];
    }
    if (tickers.length === 0) {
        Log("[WARN] Symbol data returned empty array.");
        return activeSymbols.length > 0 ? activeSymbols : [];
    }

    // Filter: USDT pairs only, exclude stablecoins, perpetual contracts
    var futures = [];
    for (var i = 0; i < tickers.length; i++) {
        var t = tickers[i];
        var sym = t.symbol; // e.g. "BTCUSDT"

        // Only symbols ending in USDT
        if (!sym || sym.slice(-4) !== "USDT") {
            continue;
        }

        // Extract base currency
        var base = sym.slice(0, -4);

        // Exclude stablecoins
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
            symbol:      binanceToFmz(sym), // convert to FMZ format
            binanceSym:  sym,
            volume:      quoteVolume
        });
    }

    // Sort descending by trading volume
    futures.sort(function (a, b) { return b.volume - a.volume; });

    // Take top TOP_SYMBOLS_COUNT symbols
    var top = [];
    var limit = Math.min(TOP_SYMBOLS_COUNT, futures.length);
    for (var j = 0; j < limit; j++) {
        top.push(futures[j].symbol);
    }

    Log("[SYMBOLS] Loaded", top.length, "symbols successfully.");
    return top;
}

 // Refresh symbol list if more than SYMBOL_REFRESH_HOURS have passed
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
// Technical Indicators
// =====================================================================

 // Calculate VWAP manually (FMZ TA library does not include VWAP)
 // VWAP = Sum(TypicalPrice x Volume) / Sum(Volume)
 // Typical price = (High + Low + Close) / 3
 // Calculated cumulatively, reset each UTC day
function calcVWAP(records) {
    var vwapArr = [];
    var cumTPV  = 0; // cumulative (typical price x volume)
    var cumVol  = 0; // cumulative volume

    var dayStart = -1;

    for (var i = 0; i < records.length; i++) {
        var r  = records[i];
        var tp = (r.High + r.Low + r.Close) / 3; // typical price

        // Extract UTC day from timestamp (Unix ms -> UTC day)
        var day = Math.floor(r.Time / 86400000);

        // Reset cumulative values at start of new day
        if (day !== dayStart) {
            cumTPV   = 0;
            cumVol   = 0;
            dayStart = day;
        }

        cumTPV += tp * r.Volume;
        cumVol += r.Volume;

        vwapArr.push(cumVol > 0 ? cumTPV / cumVol : tp);
    }

    return vwapArr; // array same length as records
}

 // Calculate simple moving average of volume (SMA 20)
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
// Market Bias Filter (Daily EMA200)
// =====================================================================

 // Fetch daily candles and determine market bias using EMA200
 // Returns "BULL" if last closed daily candle is above EMA200,
 // "BEAR" if below, "NEUTRAL" if equal or on error
function getMarketBias() {
    try {
        var dailyRecords = exchange.GetRecords(PERIOD_D1);
        if (!dailyRecords || dailyRecords.length < 201) return "NEUTRAL";

        var ema200Arr = TA.EMA(dailyRecords, 200);
        var idx       = dailyRecords.length - 2; // last fully closed daily candle
        var closePrice = dailyRecords[idx].Close;
        var ema200     = ema200Arr[idx];

        if (isNaN(ema200) || ema200 === 0) return "NEUTRAL";

        if (closePrice > ema200) return "BULL";
        if (closePrice < ema200) return "BEAR";
        return "NEUTRAL";
    } catch (e) {
        return "NEUTRAL";
    }
}

// =====================================================================
// Five-Condition Signal Check
// =====================================================================

 // Check five conditions on closed candles:
 //   1. EMA9 > EMA21 trend (long) / EMA9 < EMA21 (short)
 //   2. RSI(14): 40-65 long, 35-60 short
 //   3. Price above/below VWAP
 //   4. Volume spike > 1.5x average
 //   5. MACD line above signal line (LONG) / below signal line (SHORT)
 // Returns: "LONG", "SHORT", or null
function checkSignal(records) {
    // Need at least 30 candles for reliable calculation
    if (!records || records.length < 30) return null;

    // Exclude last candle (not yet closed)
    var recs = records.slice(0, records.length - 1);
    var n    = recs.length;
    if (n < 30) return null;

    // ─────────────────────────────────────────────
    // Calculate indicators using FMZ built-in TA library
    // ─────────────────────────────────────────────

    // EMA 9 and EMA 21
    var ema9Arr  = TA.EMA(recs, 9);
    var ema21Arr = TA.EMA(recs, 21);

    // RSI 14
    var rsiArr = TA.RSI(recs, 14);

    // MACD (12, 26, 9) — FMZ returns [DIF[], DEA[], MACD[]]
    var macdResult = TA.MACD(recs, 12, 26, 9);
    var difArr  = macdResult[0]; // MACD main line (DIF)
    var deaArr  = macdResult[1]; // Signal line (DEA)

    // VWAP (calculated manually)
    var vwapArr = calcVWAP(recs);

    // Volume SMA20
    var volSMAArr = calcVolSMA(recs, 20);

    // ─────────────────────────────────────────────
    // Read values from last two closed candles
    // cur = last closed candle | prv = candle before it
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

    // MACD values for current candle
    var difCur   = difArr[n - 1];
    var deaCur   = deaArr[n - 1];

    // Validate values
    if (isNaN(ema9Cur) || isNaN(ema9Prv) || isNaN(ema21Cur) || isNaN(ema21Prv)) return null;
    if (isNaN(rsiCur)) return null;
    if (isNaN(vwapCur) || vwapCur === 0) return null;
    if (isNaN(volSMA) || volSMA === 0) return null;
    if (isNaN(difCur) || isNaN(deaCur)) return null;

    // ─────────────────────────────────────────────
    // 1. EMA9 / EMA21 trend condition (relaxed from exact crossover)
    // ─────────────────────────────────────────────
    var emaCrossLong  = ema9Cur > ema21Cur; // bullish trend
    var emaCrossShort = ema9Cur < ema21Cur; // bearish trend

    // ─────────────────────────────────────────────
    // 2. RSI(14) condition: 40-65 for long, 35-60 for short
    // ─────────────────────────────────────────────
    var rsiLong  = (rsiCur >= 40) && (rsiCur <= 65);
    var rsiShort = (rsiCur >= 35) && (rsiCur <= 60);

    // ─────────────────────────────────────────────
    // 3. VWAP condition: price above VWAP for long, below for short
    // ─────────────────────────────────────────────
    var closeCur   = cur.Close;
    var vwapLong   = closeCur > vwapCur;
    var vwapShort  = closeCur < vwapCur;

    // ─────────────────────────────────────────────
    // 4. Volume spike condition: > 1.2x average
    // ─────────────────────────────────────────────
    var volSpike = cur.Volume > (1.2 * volSMA);

    // ─────────────────────────────────────────────
    // 5. MACD line position relative to signal line
    // ─────────────────────────────────────────────
    var macdCrossLong  = difCur > deaCur; // DIF above DEA = bullish
    var macdCrossShort = difCur < deaCur; // DIF below DEA = bearish

    // ─────────────────────────────────────────────
    // Final signal evaluation — all five conditions must be met
    // ─────────────────────────────────────────────
    var signal = null;
    if (emaCrossLong && rsiLong && vwapLong && volSpike && macdCrossLong) {
        signal = "LONG";
    }
    if (emaCrossShort && rsiShort && vwapShort && volSpike && macdCrossShort) {
        signal = "SHORT";
    }

    // ─────────────────────────────────────────────
    // Market Bias Filter (Daily EMA200)
    // ─────────────────────────────────────────────
    if (!USE_MARKET_BIAS) return signal;
    if (signal === null) return null;

    var bias = getMarketBias();
    if (bias === "NEUTRAL") return signal;
    if (bias === "BULL" && signal === "LONG")  return "LONG";
    if (bias === "BEAR" && signal === "SHORT") return "SHORT";
    return null;
}

// =====================================================================
// Symbol Scanning Cycle
// =====================================================================

 // Scan all active symbols for valid signals
 // Returns: best signal object (highest volume) or null if none found
function scanSymbols() {
    var now = new Date();
    Log("\n[SCAN] Scanning", activeSymbols.length, "symbols...",
        now.getUTCHours() + ":" + now.getUTCMinutes() + " UTC");

    var candidates = []; // list of candidate signals
    var skipped = 0, scanned = 0, errored = 0;

    for (var i = 0; i < activeSymbols.length; i++) {
        var fmzSym = activeSymbols[i];

        try {
            // Set symbol in FMZ (currency first, then perpetual swap type)
            exchange.IO("currency", fmzSym);
            exchange.SetContractType("swap");

            // Fetch candles
            var records = exchange.GetRecords(TIMEFRAME);
            if (!records || records.length < 50) {
                Log("[DEBUG]", fmzSym, "— skipped (candles:", records ? records.length : 0, ")");
                skipped++;
                Sleep(SYMBOL_DELAY_MS);
                continue;
            }

            scanned++;

            // Analyze signal
            var signal = checkSignal(records);

            if (signal) {
                // Fetch volume from current ticker
                var ticker = exchange.GetTicker();
                var vol    = ticker ? (ticker.Volume || 0) : 0;
                var price  = records[records.length - 2].Close; // last closed candle

                candidates.push({
                    symbol:    fmzSym,
                    direction: signal,
                    volume:    vol,
                    price:     price
                });

                Log("[SIGNAL]", fmzSym, "->", signal,
                    "| vol:", vol.toFixed(0));
            } else {
                Log("[DEBUG]", fmzSym, "— scanned, no signal");
            }

        } catch (e) {
            errored++;
            Log("[WARN]", fmzSym, "— error:", e.message);
        }

        Sleep(SYMBOL_DELAY_MS);
    }

    Log("[SCAN] Done — scanned:", scanned, "| skipped:", skipped, "| errors:", errored, "| signals:", candidates.length);

    if (candidates.length === 0) {
        return null;
    }

    // Select signal with highest trading volume
    var best = candidates[0];
    for (var k = 1; k < candidates.length; k++) {
        if (candidates[k].volume > best.volume) {
            best = candidates[k];
        }
    }

    Log("[SELECT] Best signal:", best.symbol, best.direction);
    return best;
}

// =====================================================================
// Get Amount Precision
// =====================================================================

 // Round value down to specified decimal places
 // Prevents order rejection due to excess precision
function floorTo(value, decimals) {
    var factor = Math.pow(10, decimals);
    return Math.floor(value * factor) / factor;
}

 // Get minimum quantity and step size from Binance Futures
 // Uses /fapi/v1/exchangeInfo
function getSymbolStepSize(binanceSym) {
    try {
        var info = exchange.IO("api", "GET", "/fapi/v1/exchangeInfo");
        if (!info || !info.symbols) return { stepSize: 0.001, pricePrecision: 2 };

        for (var i = 0; i < info.symbols.length; i++) {
            var s = info.symbols[i];
            if (s.symbol === binanceSym) {
                var stepSize       = 0.001;
                var tickSize       = 0.01;
                var pricePrecision = s.pricePrecision || 2;

                // Search symbol filters for LOT_SIZE and PRICE_FILTER
                if (s.filters) {
                    for (var j = 0; j < s.filters.length; j++) {
                        if (s.filters[j].filterType === "LOT_SIZE") {
                            stepSize = parseFloat(s.filters[j].stepSize) || 0.001;
                        }
                        if (s.filters[j].filterType === "PRICE_FILTER") {
                            tickSize = parseFloat(s.filters[j].tickSize) || 0.01;
                        }
                    }
                }
                return { stepSize: stepSize, tickSize: tickSize, pricePrecision: pricePrecision };
            }
        }
    } catch (e) {
        Log("[WARN] Failed to fetch symbol info:", e.message);
    }
    return { stepSize: 0.001, tickSize: 0.01, pricePrecision: 2 };
}

 // Calculate decimal places from stepSize value
 // Example: 0.001 -> 3 | 0.01 -> 2 | 1 -> 0
function getDecimals(stepSize) {
    if (stepSize >= 1) return 0;
    var s = stepSize.toString();
    var dotIndex = s.indexOf(".");
    if (dotIndex === -1) return 0;
    return s.length - dotIndex - 1;
}

// =====================================================================
// Place TP/SL Orders via Binance API
// =====================================================================

 // Place TAKE_PROFIT_MARKET order via Binance Futures API
 // Returns order ID or null on failure
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
            Log("[TP] Take Profit order placed: #" + result.orderId +
                " at $" + stopPrice);
            return result.orderId;
        }
    } catch (e) {
        Log("[ERROR] Failed to place TP:", e.message || e);
    }
    return null;
}

 // Place STOP_MARKET order via Binance Futures API
 // Returns order ID or null on failure
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
            Log("[SL] Stop Loss order placed: #" + result.orderId +
                " at $" + stopPrice);
            return result.orderId;
        }
    } catch (e) {
        Log("[ERROR] Failed to place SL:", e.message || e);
    }
    return null;
}

 // Cancel a specific order via Binance Futures API
function cancelOrderById(binanceSym, orderId) {
    if (!orderId) return;
    try {
        exchange.IO("api", "DELETE", "/fapi/v1/order",
            "symbol=" + binanceSym + "&orderId=" + orderId
        );
        Log("[CANCEL] Order #" + orderId + " cancelled.");
    } catch (e) {
        Log("[WARN] Failed to cancel order #" + orderId + ":", e.message || e);
    }
}

 // Cancel pending TP and SL orders for the current trade
function cancelTpSl() {
    if (!currentTrade) return;
    var binSym = fmzToBinance(currentTrade.symbol);
    cancelOrderById(binSym, currentTrade.tpOrderId);
    cancelOrderById(binSym, currentTrade.slOrderId);
    currentTrade.tpOrderId = null;
    currentTrade.slOrderId = null;
}

// =====================================================================
// Set Leverage
// =====================================================================

 // Set leverage for a symbol via Binance API
 // Returns true on success, false on failure
function setLeverage(binanceSym, leverage) {
    try {
        exchange.IO("api", "POST", "/fapi/v1/leverage",
            "symbol=" + binanceSym + "&leverage=" + leverage
        );
        return true;
    } catch (e) {
        Log("[WARN] Failed to set leverage for", binanceSym, ":", e.message || e);
        return false;
    }
}

 // Set isolated margin mode for a symbol
function setIsolatedMargin(binanceSym) {
    try {
        exchange.IO("api", "POST", "/fapi/v1/marginType",
            "symbol=" + binanceSym + "&marginType=ISOLATED"
        );
    } catch (e) {
        // Some errors are expected if mode is already set
        var msg = e.message || e.toString();
        if (msg.indexOf("already") === -1 && msg.indexOf("No need") === -1) {
            Log("[WARN] Margin type:", msg);
        }
    }
}

// =====================================================================
// Trade Execution
// =====================================================================

 // Execute a full trade:
 //   1. Set leverage and margin type
 //   2. Fetch balance and calculate position size (full compounding)
 //   3. Execute market order
 //   4. Place TP and SL orders
 // Returns true on success, false on failure
function executeTrade(signal) {
    var fmzSym  = signal.symbol;
    var dir     = signal.direction; // "LONG" or "SHORT"
    var binSym  = fmzToBinance(fmzSym);

    Log("\n[TRADE] Opening", dir, "on", fmzSym);

    // ────────────────────────────────────────
    // 1. Set symbol in FMZ
    // ────────────────────────────────────────
    try {
        exchange.IO("currency", fmzSym);
        exchange.SetContractType("swap");
    } catch (e) {
        Log("[ERROR] Failed to set contract:", fmzSym, e.message);
        return false;
    }

    // ────────────────────────────────────────
    // 2. Set leverage and margin type
    // ────────────────────────────────────────
    if (!setLeverage(binSym, LEVERAGE)) {
        return false;
    }
    setIsolatedMargin(binSym);

    // ────────────────────────────────────────
    // 3. Fetch available balance
    // ────────────────────────────────────────
    var account = retryCall(function () { return exchange.GetAccount(); });
    if (!account) {
        Log("[ERROR] Failed to fetch balance.");
        return false;
    }

    // In FMZ futures: Balance = available USDT balance
    var freeUsdt = account.Balance;
    if (freeUsdt <= 0) {
        Log("[WARN] No free balance available — skipping trade.");
        return false;
    }

    // ────────────────────────────────────────
    // 4. Fetch current price and calculate size
    // ────────────────────────────────────────
    var ticker = retryCall(function () { return exchange.GetTicker(); });
    if (!ticker) {
        Log("[ERROR] Failed to fetch price.");
        return false;
    }
    var entryEstimate = ticker.Last;

    // Fetch symbol precision info
    var symInfo    = getSymbolStepSize(binSym);
    var stepSize   = symInfo.stepSize;
    var priceDec   = getDecimals(symInfo.tickSize);
    var amountDec  = getDecimals(stepSize);

    // Calculate position size: risk a fixed % of balance, capped at MAX_ORDER_USDT
    var tradeUsdt = Math.min(freeUsdt * RISK_PER_TRADE_PCT, MAX_ORDER_USDT);
    Log("[SIZE] Trade allocation: $" + tradeUsdt.toFixed(2) +
        " (" + (RISK_PER_TRADE_PCT * 100).toFixed(0) + "% of $" + freeUsdt.toFixed(2) + ")");
    var rawSize  = (tradeUsdt * LEVERAGE) / entryEstimate;
    var size     = floorTo(rawSize, amountDec);

    // Ensure size is not below stepSize
    if (size < stepSize || size <= 0) {
        Log("[ERROR] Position size zero or below minimum:", size, "| stepSize:", stepSize);
        return false;
    }

    Log("[SIZE] Balance: $" + freeUsdt.toFixed(2) +
        " | Size: " + size + " @ ~$" + entryEstimate.toFixed(4));

    // ────────────────────────────────────────
    // 5. Execute market order via FMZ
    // ────────────────────────────────────────
    var orderId = null;
    try {
        if (dir === "LONG") {
            // Open long position
            exchange.SetDirection("buy");
            orderId = exchange.Buy(-1, size); // -1 = market order
        } else {
            // Open short position
            exchange.SetDirection("sell");
            orderId = exchange.Sell(-1, size); // -1 = market order
        }
    } catch (e) {
        Log("[ERROR] Failed to execute market order:", e.message || e);
        return false;
    }

    if (!orderId) {
        Log("[ERROR] No order ID returned — order failed.");
        return false;
    }

    // Wait 1 second to get actual fill price
    Sleep(1000);

    // Fetch actual fill price
    var fillPrice = entryEstimate;
    try {
        var orderInfo = exchange.GetOrder(orderId);
        if (orderInfo && orderInfo.AvgPrice && orderInfo.AvgPrice > 0) {
            fillPrice = orderInfo.AvgPrice;
        } else if (orderInfo && orderInfo.Price && orderInfo.Price > 0) {
            fillPrice = orderInfo.Price;
        }
    } catch (e) {
        Log("[WARN] Using estimated price: $" + fillPrice.toFixed(6));
    }

    Log("[FILL] Filled at: $" + fillPrice.toFixed(6));

    // ────────────────────────────────────────
    // 6. Calculate TP and SL prices
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

    // Fix 1: Validate TP and SL are distinct from entry price
    if (tpPrice === fillPrice || slPrice === fillPrice) {
        Log("[SKIP] Symbol skipped — price precision too low for TP/SL on " + binSym);
        exchange.SetDirection(dir === "LONG" ? "closebuy" : "closesell");
        if (dir === "LONG") { exchange.Sell(-1, size); } else { exchange.Buy(-1, size); }
        return false;
    }

    Log("[TARGETS] TP: $" + tpPrice.toFixed(priceDec) +
        " | SL: $" + slPrice.toFixed(priceDec));

    // ────────────────────────────────────────
    // 7. Place TP and SL orders via Binance API
    // ────────────────────────────────────────
    var closeSide = (dir === "LONG") ? "SELL" : "BUY";

    var tpOrderId = placeTakeProfitOrder(binSym, closeSide, tpPrice.toFixed(priceDec));
    var slOrderId = placeStopLossOrder  (binSym, closeSide, slPrice.toFixed(priceDec));

    // ────────────────────────────────────────
    // 8. Save trade info to global variable
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

    var marginUsed = (currentTrade.size * currentTrade.entryPrice / LEVERAGE).toFixed(2);
    sendTelegram(
        "<b>🟢 TRADE OPENED</b>\n" +
        "━━━━━━━━━━━━━━━━━━\n" +
        "Symbol: " + currentTrade.symbol + "\n" +
        "Direction: " + currentTrade.direction + "\n" +
        "Entry Price: $" + currentTrade.entryPrice.toFixed(4) + "\n" +
        "Margin: $" + marginUsed + "\n" +
        "Take Profit: $" + currentTrade.tpPrice.toFixed(4) + "\n" +
        "Stop Loss: $" + currentTrade.slPrice.toFixed(4)
    );

    return true;
}

// =====================================================================
// Check Position Status
// =====================================================================

 // Check whether the position is still open
 // Returns true if open, false if closed
function isPositionOpen() {
    try {
        var positions = exchange.GetPosition();
        if (!positions || positions.length === 0) return false;

        var fmzSym = currentTrade.symbol;
        for (var i = 0; i < positions.length; i++) {
            var pos = positions[i];
            // FMZ returns ContractType for futures positions
            if (pos.ContractType === fmzSym && Math.abs(pos.Amount) > 0) {
                return true;
            }
        }
        return false;
    } catch (e) {
        // Assume open if in doubt
        return true;
    }
}

 // Fetch current price for the active symbol
function getCurrentPrice() {
    var ticker = retryCall(function () { return exchange.GetTicker(); });
    return ticker ? ticker.Last : 0;
}

 // Close open position with market order (for timeout or emergency stop)
function closePositionMarket() {
    if (!currentTrade) return;

    var dir  = currentTrade.direction;
    var size = currentTrade.size;

    if (!size || size <= 0) return;

    try {
        if (dir === "LONG") {
            // Close long: sell
            exchange.SetDirection("closebuy");
            exchange.Sell(-1, size);
        } else {
            // Close short: buy
            exchange.SetDirection("closesell");
            exchange.Buy(-1, size);
        }
        Log("[CLOSE] Position closed at market on", currentTrade.symbol);
    } catch (e) {
        Log("[ERROR] Failed to close position:", e.message || e);
    }
}

// =====================================================================
// Trade Monitoring
// =====================================================================

 // Monitor open trade until closed by one of:
 //   - TP      : price reached take profit
 //   - SL      : price reached stop loss
 //   - TIMEOUT : trade exceeded MAX_TRADE_MINUTES
 // After close: updates stats, prints result, logs profit to FMZ
function monitorTrade() {
    if (!currentTrade) return;

    var symbol      = currentTrade.symbol;
    var dir         = currentTrade.direction;
    var entryPrice  = currentTrade.entryPrice;
    var tpPrice     = currentTrade.tpPrice;
    var slPrice     = currentTrade.slPrice;
    var entryTime   = currentTrade.entryTime;
    var maxMs       = MAX_TRADE_MINUTES * 60 * 1000; // in milliseconds

    var closeReason = "TIMEOUT";
    var closePrice  = entryPrice;

    Log("\n[MONITOR] Monitoring", dir, "trade on", symbol);
    Log("[MONITOR] Entry: $" + entryPrice.toFixed(6) +
        " | TP: $" + tpPrice.toFixed(6) +
        " | SL: $" + slPrice.toFixed(6));

    // Confirm symbol in FMZ before monitoring
    try { exchange.IO("currency", symbol); exchange.SetContractType("swap"); } catch (e) {}

    // ─────────────────────────────────────────
    // Monitoring loop — runs until trade closes
    // ─────────────────────────────────────────
    while (true) {
        var elapsed = Date.now() - entryTime;

        // Check timeout
        if (elapsed >= maxMs) {
            Log("[TIMEOUT] Trade exceeded " + MAX_TRADE_MINUTES + " min — closing...");
            cancelTpSl();
            closePositionMarket();
            closePrice  = getCurrentPrice();
            closeReason = "TIMEOUT";
            break;
        }

        // Check position status
        var posOpen = isPositionOpen();
        if (!posOpen) {
            // Position closed by TP or SL automatically
            var curPrice = getCurrentPrice();

            // Determine close reason based on direction and price
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

            // Cancel any remaining orders
            cancelTpSl();
            Log("[CLOSED] Trade closed by: " + closeReason +
                " | Price: $" + closePrice.toFixed(6));
            break;
        }

        // Print trade status
        var remaining = maxMs - elapsed;
        var mins = Math.floor(remaining / 60000);
        var secs = Math.floor((remaining % 60000) / 1000);
        var curP = getCurrentPrice();
        Log("[MONITOR] Price: $" + curP.toFixed(6) +
            " | Time left: " + mins + "m " + secs + "s");

        Sleep(POSITION_POLL_MS);
    }

    // ─────────────────────────────────────────
    // PnL Calculation
    // ─────────────────────────────────────────
    var pnlPct;
    if (dir === "LONG") {
        pnlPct = (closePrice - entryPrice) / entryPrice;
    } else {
        pnlPct = (entryPrice - closePrice) / entryPrice;
    }

    var pnlUsdt = pnlPct * currentTrade.size * entryPrice;

    // Update statistics
    stats.totalTrades += 1;
    stats.totalPnl    += pnlUsdt;

    if (closeReason === "TP") {
        stats.wins += 1;
    } else if (closeReason === "SL") {
        stats.losses      += 1;
        stats.realizedLoss += Math.abs(pnlUsdt); // accumulate SL loss
    } else {
        stats.timeouts += 1;
    }

    // Fetch updated balance from FMZ
    var accountUpdated = retryCall(function () { return exchange.GetAccount(); });
    if (accountUpdated) {
        // Balance + FrozenBalance = total balance
        stats.balance = (accountUpdated.Balance || 0) +
                        (accountUpdated.FrozenBalance || 0);
    } else {
        stats.balance += pnlUsdt;
    }

    var pnlSign = pnlUsdt >= 0 ? "+" : "";
    Log("\n======================================");
    Log("[RESULT] Close reason :", closeReason);
    Log("[RESULT] PnL          :", pnlSign + pnlUsdt.toFixed(4) + " USDT",
        "(" + pnlSign + (pnlPct * 100).toFixed(4) + "%)");
    Log("[RESULT] New balance  : $" + stats.balance.toFixed(2));
    Log("======================================\n");

    // Telegram notification — trade closed
    var pnlSign   = pnlUsdt >= 0 ? "+" : "";
    var closeEmoji = closeReason === "TP" ? "✅" :
                     closeReason === "SL" ? "🔴" : "⏱";
    var closeLabel = closeReason === "TP"      ? "TAKE PROFIT" :
                     closeReason === "SL"      ? "STOP LOSS" :
                     closeReason === "TIMEOUT" ? "TIMEOUT (20min)" : closeReason;
    var marginClosed = (currentTrade.size * currentTrade.entryPrice / LEVERAGE).toFixed(2);
    var totalRealizedLoss = (INITIAL_CAPITAL - stats.balance).toFixed(2);

    sendTelegram(
        closeEmoji + " <b>TRADE CLOSED — " + closeLabel + "</b>\n" +
        "━━━━━━━━━━━━━━━━━━\n" +
        "Symbol: " + currentTrade.symbol + "\n" +
        "Direction: " + currentTrade.direction + "\n" +
        "Margin: $" + marginClosed + "\n" +
        "PnL: " + pnlSign + "$" + pnlUsdt.toFixed(2) + " USDT\n" +
        "New Balance: $" + stats.balance.toFixed(2) + "\n" +
        "Total Realized Loss: $" + totalRealizedLoss
    );

    // Log profit to FMZ platform (shown in performance chart)
    LogProfit(stats.balance);

    // Reset trade state
    currentTrade = null;

    // Print dashboard after each trade
    printDashboard();
}

// =====================================================================
// Dashboard
// =====================================================================

 // Print full dashboard to FMZ log
 // Printed after each trade and every DASHBOARD_INTERVAL ms
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
        timeDisp = rMin + "m " + rSec + "s";
    }

    var pnlSign = totalPnl >= 0 ? "+" : "";

    Log("+----------------------------------------------+");
    Log("|        THE SURGEON BOT -- LIVE               |");
    Log("+----------------------------------------------+");
    Log("|  Balance            : $" + balance.toFixed(2) + " USDT");
    Log("|  Initial Capital    : $" + INITIAL_CAPITAL.toFixed(2));
    Log("|  Total PnL          : " + pnlSign + "$" + totalPnl.toFixed(2) +
        "  (" + pnlSign + pnlPctTotal.toFixed(2) + "%)");
    Log("+----------------------------------------------+");
    Log("|  Total Trades       :", total);
    Log("|  Wins               :", wins, " (" + winPct.toFixed(1) + "%)");
    Log("|  Losses             :", losses, " (" + lossPct.toFixed(1) + "%)");
    Log("|  Timeouts           :", timeouts);
    Log("|  Realized Loss      : $" + stats.realizedLoss.toFixed(2) + " / $" + MAX_DAILY_LOSS + " limit");
    Log("+----------------------------------------------+");
    Log("|  Status             :", status);
    Log("|  Market Bias        :", getMarketBias());
    Log("|  Symbol             :", symDisp);
    Log("|  Direction          :", dirDisp);
    Log("|  Entry Price        :", entryDisp);
    Log("|  Take Profit        :", tpDisp);
    Log("|  Stop Loss          :", slDisp);
    Log("|  Time Remaining     :", timeDisp);
    Log("|  Symbols Watched    :", activeSymbols.length);
    Log("+----------------------------------------------+");
}

// =====================================================================
// Startup Banner
// =====================================================================

 // Print startup banner with configuration info
function printBanner() {
    Log("+------------------------------------------------------+");
    Log("|          THE SURGEON BOT -- FMZ QUANT               |");
    Log("|          Binance Futures Scalping Bot                |");
    Log("+------------------------------------------------------+");
    Log("|  Platform           : FMZ Quant (fmz.com)");
    Log("|  Exchange           : Binance USDT-M Futures" + (TESTNET ? " [TESTNET]" : ""));
    Log("|  Initial Capital    : $" + INITIAL_CAPITAL);
    Log("|  Leverage           : " + LEVERAGE + "x");
    Log("|  Timeframe          : 5 minutes");
    Log("|  Target             : +2.0% | Stop Loss: -0.7%");
    Log("|  Max Trade Duration : " + MAX_TRADE_MINUTES + " minutes");
    Log("|  Symbols Watched    : " + TOP_SYMBOLS_COUNT);
    Log("+------------------------------------------------------+");
}

// =====================================================================
// Main Loop (FMZ entry point)
// =====================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Telegram notification helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmzEncode(str) {
    var result = "";
    for (var i = 0; i < str.length; i++) {
        var c = str[i];
        if (c === " ")  { result += "%20"; }
        else if (c === "\n") { result += "%0A"; }
        else if (c === "&")  { result += "%26"; }
        else if (c === "+")  { result += "%2B"; }
        else if (c === "#")  { result += "%23"; }
        else if (c === "%")  { result += "%25"; }
        else if (c === "=")  { result += "%3D"; }
        else if (c === "?")  { result += "%3F"; }
        else if (c === "<")  { result += "%3C"; }
        else if (c === ">")  { result += "%3E"; }
        else { result += c; }
    }
    return result;
}

function sendTelegram(msg) {
    try {
        var url = "https://api.telegram.org/bot" + TELEGRAM_TOKEN +
                  "/sendMessage?chat_id=" + TELEGRAM_CHAT_ID +
                  "&text=" + fmzEncode(msg) +
                  "&parse_mode=HTML";
        HttpQuery(url);
    } catch(e) {
        Log("[WARN] Telegram send failed:", e.message || e);
    }
}

function bufferLog(key) {
    if (!hourlyLogBuffer[key]) {
        hourlyLogBuffer[key] = 0;
    }
    hourlyLogBuffer[key] += 1;
}

function sendHourlyNotification() {
    var now = Date.now();
    if (now - lastTelegramTime < TELEGRAM_NOTIFY_MS) return;
    lastTelegramTime = now;

    var statusEmoji = (currentTrade !== null) ? "👍🏻 Running — In Trade" : "👍🏻 Running — Scanning";
    var realizedLoss = INITIAL_CAPITAL - stats.balance;

    var summary = "";
    var keys = Object.keys(hourlyLogBuffer);
    if (keys.length === 0) {
        summary = "No activity this hour.";
    } else {
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            var count = hourlyLogBuffer[k];
            if (count === 1) {
                summary += k + "\n";
            } else {
                summary += k + " x" + count + "\n";
            }
        }
    }

    hourlyLogBuffer = {};

    var msg =
        "<b>🤖 Surgeon Bot — Hourly Report</b>\n" +
        "━━━━━━━━━━━━━━━━━━\n" +
        statusEmoji + "\n" +
        "Balance: $" + stats.balance.toFixed(2) + "\n" +
        "Realized Loss: $" + realizedLoss.toFixed(2) + "\n" +
        "Total Trades: " + stats.totalTrades + "\n" +
        "Wins: " + stats.wins + " | Losses: " + stats.losses + " | Timeouts: " + stats.timeouts + "\n" +
        "━━━━━━━━━━━━━━━━━━\n" +
        "<b>Last Hour Activity:</b>\n" +
        summary;

    sendTelegram(msg);
}

// Main function — called automatically by FMZ when strategy starts
// Runs in infinite loop until stopped from FMZ dashboard
function main() {
    // Print banner
    printBanner();

    // Guard: exchange must be bound in FMZ before starting
    if (typeof exchange === "undefined" || exchange === null) {
        Log("[FATAL] No exchange object found. Please add a Binance Futures exchange account");
        Log("[FATAL] in FMZ → My Exchanges and attach it to this live bot, then restart.");
        throw new Error("Exchange not configured — bot halted.");
    }

    // Validate settings
    if (LEVERAGE < 1 || LEVERAGE > 125) {
        Log("[ERROR] Leverage must be between 1 and 125!");
        return;
    }

    // Fetch initial balance
    Log("[CONNECT] Connecting to Binance Futures...");
    var account = retryCall(function () { return exchange.GetAccount(); });
    if (account) {
        var actualBalance = (account.Balance || 0) + (account.FrozenBalance || 0);
        if (actualBalance > 0) {
            stats.balance = actualBalance;
        }
        Log("[BALANCE] Current balance: $" + stats.balance.toFixed(2) + " USDT");
    } else {
        Log("[WARN] Failed to fetch balance — using initial capital: $" + INITIAL_CAPITAL);
    }

    // Load initial symbol list — retry up to 5 times before giving up
    Log("[INIT] Loading symbol list...");
    for (var initAttempt = 1; initAttempt <= 5; initAttempt++) {
        activeSymbols = fetchTopSymbols();
        if (activeSymbols && activeSymbols.length > 0) break;
        Log("[INIT] Attempt " + initAttempt + "/5 failed — retrying in 10s...");
        Sleep(10000);
    }
    symbolsLastUpdated = Date.now();

    if (!activeSymbols || activeSymbols.length === 0) {
        Log("[ERROR] Failed to load symbol list after 5 attempts! Check exchange connection.");
        return;
    }

    Log("[READY] Loaded " + activeSymbols.length + " symbols. Bot is running!");
    printDashboard();

    // Main infinite loop
    while (true) {

        sendHourlyNotification();

        // Refresh symbol list every 4 hours
        maybeRefreshSymbols();

        // Update balance from exchange
        var accCheck = retryCall(function () { return exchange.GetAccount(); });
        if (accCheck) {
            stats.balance = (accCheck.Balance || 0) + (accCheck.FrozenBalance || 0);
        }

        // Check cumulative realized loss limit
        if (stats.realizedLoss >= MAX_DAILY_LOSS) {
            Log("\n[CRITICAL] Realized loss $" + stats.realizedLoss.toFixed(2) +
                " reached limit $" + MAX_DAILY_LOSS +
                " from initial capital $" + INITIAL_CAPITAL + " — stopping for review.");
            printDashboard();
            sendTelegram(
                "👎🏻 <b>SURGEON BOT STOPPED</b>\n" +
                "━━━━━━━━━━━━━━━━━━\n" +
                "Reason: Realized loss limit reached\n" +
                "Loss: $" + (INITIAL_CAPITAL - stats.balance).toFixed(2) + "\n" +
                "Initial Capital: $" + INITIAL_CAPITAL + "\n" +
                "Final Balance: $" + stats.balance.toFixed(2) + "\n" +
                "Review your strategy before restarting."
            );
            break; // Stop loop — FMZ will halt the strategy
        }

        // If no open trade, look for a signal
        if (!currentTrade) {
            var signal = scanSymbols();
            bufferLog("SCAN");

            if (signal) {
                bufferLog("SIGNAL FOUND");
                // Attempt to execute trade
                var success = executeTrade(signal);

                if (success) {
                    // Monitor trade until closed (TP / SL / TIMEOUT)
                    monitorTrade();
                } else {
                    bufferLog("TRADE ERROR");
                    Log("[WARN] Failed to execute trade on", signal.symbol);
                    Sleep(5000);
                }

            } else {
                bufferLog("NO SIGNAL");
                Log("[SCAN] No signals found — waiting " +
                    (SCAN_INTERVAL_MS / 1000) + " seconds...");

                // Print dashboard every DASHBOARD_INTERVAL
                if (Date.now() - lastDashboardPrint >= DASHBOARD_INTERVAL) {
                    printDashboard();
                }

                Sleep(SCAN_INTERVAL_MS);
            }

        } else {
            // Unexpected state — resume monitoring existing trade
            Log("[RESUME] Resuming monitor on existing trade:", currentTrade.symbol);

            // Confirm symbol is set
            try { exchange.IO("currency", currentTrade.symbol); exchange.SetContractType("swap"); } catch (e) {}

            monitorTrade();
        }
    }

    Log("[STOP] Bot stopped.");
    printDashboard();
}
