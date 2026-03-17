"""
╔══════════════════════════════════════════════════╗
║         🔪 THE SURGEON BOT — BINANCE FUTURES     ║
║         بوت التداول الجراح — عقود بينانس الآجلة  ║
╚══════════════════════════════════════════════════╝

بوت سكالبينج كامل للعقود الآجلة على Binance Futures
يستخدم: ccxt للاتصال بالبورصة، pandas للبيانات، pandas_ta للمؤشرات
"""

# =====================================================================
# المكتبات المطلوبة — Required Libraries
# =====================================================================
import ccxt
import pandas as pd
import pandas_ta as ta
import time
import csv
import os
import sys
import math
import traceback
from datetime import datetime, timezone

# =====================================================================
# الإعدادات الرئيسية — Main Configuration
# =====================================================================
API_KEY           = ""
API_SECRET        = ""
TESTNET           = True
INITIAL_CAPITAL   = 500
TOP_SYMBOLS_COUNT = 200

# =====================================================================
# ثوابت الاستراتيجية — Strategy Constants
# =====================================================================
TIMEFRAME            = "5m"            # الإطار الزمني
CANDLES_LIMIT        = 200             # عدد الشمعات للتحليل
LEVERAGE             = 10              # الرافعة المالية
TP_PCT_LONG          = 1.020           # هدف الربح للشراء
TP_PCT_SHORT         = 0.980           # هدف الربح للبيع
SL_PCT_LONG          = 0.993           # وقف الخسارة للشراء
SL_PCT_SHORT         = 1.007           # وقف الخسارة للبيع
MAX_TRADE_MINUTES    = 20              # الحد الأقصى لمدة الصفقة بالدقائق
SCAN_INTERVAL        = 30             # الفاصل الزمني بين الدورات بالثواني
SYMBOL_DELAY         = 0.2            # تأخير بين كل رمز لتجنب تجاوز الحد
POSITION_POLL        = 10             # استطلاع المراكز كل 10 ثوانٍ
MIN_BALANCE          = 50             # الحد الأدنى للرصيد قبل الإيقاف
SYMBOL_REFRESH_HOURS = 4             # تحديث قائمة الرموز كل 4 ساعات
API_RETRIES          = 3             # عدد المحاولات عند فشل API
API_RETRY_DELAY      = 5             # تأخير بين المحاولات بالثواني
DASHBOARD_INTERVAL   = 300           # طباعة اللوحة كل 5 دقائق

# =====================================================================
# المتغيرات العالمية — Global State Variables
# =====================================================================
# قائمة الرموز النشطة
active_symbols: list = []
symbols_last_updated: float = 0.0

# حالة الصفقة الحالية
current_trade: dict = {}

# إحصائيات الأداء
stats = {
    "balance":       float(INITIAL_CAPITAL),
    "total_trades":  0,
    "wins":          0,
    "losses":        0,
    "timeouts":      0,
    "total_pnl":     0.0,
}

# ملف السجل
LOG_FILE = "trades_log.csv"
LOG_HEADERS = [
    "timestamp", "symbol", "direction", "entry_price",
    "close_price", "close_reason", "pnl_usdt", "pnl_pct", "balance_after"
]

# وقت آخر طباعة للوحة
last_dashboard_print: float = 0.0

# =====================================================================
# إعداد الاتصال بالبورصة — Exchange Connection Setup
# =====================================================================

def create_exchange() -> ccxt.binanceusdm:
    """
    إنشاء كائن الاتصال ببورصة Binance USDT-M Futures.
    نستخدم ccxt.binanceusdm بدلاً من ccxt.binance لأنه مخصص لعقود USDT الدائمة،
    و set_sandbox_mode(True) يعيّن روابط testnet.binancefuture.com تلقائياً.
    Using binanceusdm instead of binance so set_sandbox_mode correctly targets
    the futures testnet (testnet.binancefuture.com) not the spot testnet.
    """
    exchange = ccxt.binanceusdm({
        "apiKey": API_KEY,
        "secret": API_SECRET,
    })

    if TESTNET:
        exchange.set_sandbox_mode(True)

    exchange.load_markets()
    return exchange

# =====================================================================
# مساعد لاستدعاء API مع إعادة المحاولة — API Call with Retry
# =====================================================================

def api_call(func, *args, **kwargs):
    """
    تغليف استدعاء API مع إعادة المحاولة 3 مرات
    Wraps any API call with retry logic (3 attempts, 5s delay).
    """
    for attempt in range(1, API_RETRIES + 1):
        try:
            return func(*args, **kwargs)
        except (ccxt.NetworkError, ccxt.RequestTimeout) as e:
            print(f"  [تحذير] خطأ في الشبكة (محاولة {attempt}/{API_RETRIES}): {e}")
            if attempt < API_RETRIES:
                time.sleep(API_RETRY_DELAY)
        except ccxt.ExchangeError as e:
            print(f"  [خطأ] خطأ في البورصة: {e}")
            if attempt < API_RETRIES:
                time.sleep(API_RETRY_DELAY)
        except Exception as e:
            print(f"  [خطأ غير متوقع] {e}")
            if attempt < API_RETRIES:
                time.sleep(API_RETRY_DELAY)
    return None

# =====================================================================
# تسجيل ملف CSV — CSV Logging
# =====================================================================

def init_log():
    """إنشاء ملف السجل بالترويسات إذا لم يكن موجوداً"""
    if not os.path.exists(LOG_FILE):
        with open(LOG_FILE, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(LOG_HEADERS)
        print(f"  [سجل] تم إنشاء ملف السجل: {LOG_FILE}")


def log_trade(symbol: str, direction: str, entry_price: float,
              close_price: float, close_reason: str,
              pnl_usdt: float, pnl_pct: float, balance_after: float):
    """تسجيل صفقة مكتملة في ملف CSV"""
    row = [
        datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        symbol,
        direction,
        round(entry_price, 8),
        round(close_price, 8),
        close_reason,
        round(pnl_usdt, 4),
        round(pnl_pct, 4),
        round(balance_after, 4),
    ]
    with open(LOG_FILE, "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(row)

# =====================================================================
# تحميل وتحديث قائمة الرموز — Symbol List Load & Refresh
# =====================================================================

# العملات المستقرة المستثناة — Stablecoins to exclude
STABLE_COINS = {"USDC", "BUSD", "TUSD", "USDP", "DAI", "FDUSD"}


def fetch_top_symbols(exchange: ccxt.binanceusdm) -> list:
    """
    جلب أفضل 200 رمز بحجم التداول من عقود USDT الدائمة
    Fetch top 200 USDT perpetual futures by 24h quote volume.
    """
    print("  [رموز] جاري تحديث قائمة الرموز...")
    try:
        # جلب بيانات حجم التداول 24 ساعة
        tickers = api_call(exchange.fetch_tickers)
        if tickers is None:
            print("  [تحذير] فشل جلب بيانات الرموز، ستُستخدم القائمة القديمة.")
            return active_symbols

        usdt_futures = []
        for symbol, ticker in tickers.items():
            # فلترة: USDT فقط، عقود دائمة، وليست عملات مستقرة
            if not symbol.endswith("/USDT:USDT"):
                continue
            base = symbol.split("/")[0]
            if base in STABLE_COINS:
                continue
            quote_volume = ticker.get("quoteVolume") or 0
            usdt_futures.append((symbol, quote_volume))

        # ترتيب تنازلي حسب حجم التداول
        usdt_futures.sort(key=lambda x: x[1], reverse=True)
        top = [s[0] for s in usdt_futures[:TOP_SYMBOLS_COUNT]]
        print(f"  [رموز] تم تحميل {len(top)} رمزاً بنجاح.")
        return top

    except Exception as e:
        print(f"  [خطأ] فشل تحديث الرموز: {e}")
        return active_symbols


def maybe_refresh_symbols(exchange: ccxt.binanceusdm):
    """تحديث قائمة الرموز كل 4 ساعات"""
    global active_symbols, symbols_last_updated
    now = time.time()
    if now - symbols_last_updated >= SYMBOL_REFRESH_HOURS * 3600:
        active_symbols = fetch_top_symbols(exchange)
        symbols_last_updated = now

# =====================================================================
# جلب الشمعات وحساب المؤشرات — Candles & Indicators
# =====================================================================

def fetch_candles(exchange: ccxt.binanceusdm, symbol: str) -> pd.DataFrame | None:
    """
    جلب آخر 200 شمعة مغلقة بالإطار الزمني 5 دقائق
    Returns a DataFrame with OHLCV data, or None on failure.
    """
    ohlcv = api_call(
        exchange.fetch_ohlcv,
        symbol,
        TIMEFRAME,
        limit=CANDLES_LIMIT + 1  # +1 للتأكد من الحصول على 200 شمعة مغلقة
    )
    if ohlcv is None or len(ohlcv) < 50:
        return None

    df = pd.DataFrame(ohlcv, columns=["timestamp", "open", "high", "low", "close", "volume"])
    df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)

    # استبعاد الشمعة الأخيرة (غير مغلقة بعد)
    df = df.iloc[:-1].reset_index(drop=True)
    return df


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """
    حساب جميع المؤشرات التقنية المطلوبة
    EMA9, EMA21, RSI14, VWAP, Volume SMA20, MACD(12,26,9)
    """
    # المتوسطات المتحركة الأسية
    df.ta.ema(length=9,  append=True)   # EMA_9
    df.ta.ema(length=21, append=True)   # EMA_21

    # مؤشر القوة النسبية
    df.ta.rsi(length=14, append=True)   # RSI_14

    # VWAP — pandas_ta يتطلب DatetimeIndex مرتبة لحساب VWAP
    # نضع العمود timestamp كـ index مؤقتاً ثم نعيد تعيينه
    df_indexed = df.set_index("timestamp")
    vwap_series = df_indexed.ta.vwap()   # VWAP_D
    if vwap_series is not None:
        if isinstance(vwap_series, pd.DataFrame):
            for col in vwap_series.columns:
                df[col] = vwap_series[col].values
        else:
            df[vwap_series.name] = vwap_series.values

    # MACD
    df.ta.macd(fast=12, slow=26, signal=9, append=True)
    # الأعمدة الناتجة: MACD_12_26_9, MACDh_12_26_9, MACDs_12_26_9

    # متوسط الحجم لآخر 20 شمعة
    df["vol_sma20"] = df["volume"].rolling(20).mean()

    return df


def get_vwap_column(df: pd.DataFrame) -> str | None:
    """إيجاد عمود VWAP في الـ DataFrame"""
    for col in df.columns:
        if col.upper().startswith("VWAP"):
            return col
    return None

# =====================================================================
# منطق إشارة الدخول — Entry Signal Logic
# =====================================================================

def check_signal(df: pd.DataFrame) -> str | None:
    """
    فحص الشروط الخمسة للإشارة على الشمعة المغلقة الأخيرة.
    Returns: 'LONG', 'SHORT', or None
    """
    if len(df) < 30:
        return None

    # الصف الأخير (الشمعة المغلقة الأخيرة) والصف قبل الأخير
    cur = df.iloc[-1]
    prv = df.iloc[-2]

    # ───────────────────────────────────────
    # 1. تقاطع EMA9 مع EMA21
    # ───────────────────────────────────────
    ema9_col  = "EMA_9"
    ema21_col = "EMA_21"
    if ema9_col not in df.columns or ema21_col not in df.columns:
        return None

    ema_cross_long  = (prv[ema9_col] < prv[ema21_col]) and (cur[ema9_col] > cur[ema21_col])
    ema_cross_short = (prv[ema9_col] > prv[ema21_col]) and (cur[ema9_col] < cur[ema21_col])

    # ───────────────────────────────────────
    # 2. RSI(14) في النطاق المحدد
    # ───────────────────────────────────────
    rsi_col = "RSI_14"
    if rsi_col not in df.columns:
        return None
    rsi = cur[rsi_col]
    if pd.isna(rsi):
        return None

    rsi_long  = 45 <= rsi <= 60
    rsi_short = 40 <= rsi <= 55

    # ───────────────────────────────────────
    # 3. VWAP — السعر فوق/تحت VWAP
    # ───────────────────────────────────────
    vwap_col = get_vwap_column(df)
    if vwap_col is None:
        return None
    vwap = cur[vwap_col]
    if pd.isna(vwap):
        return None

    close = cur["close"]
    vwap_long  = close > vwap
    vwap_short = close < vwap

    # ───────────────────────────────────────
    # 4. حجم أكبر من 1.5× المتوسط
    # ───────────────────────────────────────
    vol_sma = cur["vol_sma20"]
    if pd.isna(vol_sma) or vol_sma == 0:
        return None
    vol_spike = cur["volume"] > (1.5 * vol_sma)

    # ───────────────────────────────────────
    # 5. تقاطع خط MACD مع خط الإشارة في آخر شمعتين
    # ───────────────────────────────────────
    macd_col  = "MACD_12_26_9"
    sig_col   = "MACDs_12_26_9"
    if macd_col not in df.columns or sig_col not in df.columns:
        return None

    # فحص التقاطع على آخر شمعتين
    c1, c2 = df.iloc[-2], df.iloc[-1]   # السابقة، الحالية
    p1, p2 = df.iloc[-3], df.iloc[-2]   # قبل السابقة، السابقة

    def macd_crossed_above(row_prev, row_curr):
        return (row_prev[macd_col] < row_prev[sig_col]) and (row_curr[macd_col] > row_curr[sig_col])

    def macd_crossed_below(row_prev, row_curr):
        return (row_prev[macd_col] > row_prev[sig_col]) and (row_curr[macd_col] < row_curr[sig_col])

    macd_cross_long  = macd_crossed_above(p1, p2) or macd_crossed_above(c1, c2)
    macd_cross_short = macd_crossed_below(p1, p2) or macd_crossed_below(c1, c2)

    # ───────────────────────────────────────
    # تقييم الإشارة النهائية
    # ───────────────────────────────────────
    if (ema_cross_long and rsi_long and vwap_long and vol_spike and macd_cross_long):
        return "LONG"
    if (ema_cross_short and rsi_short and vwap_short and vol_spike and macd_cross_short):
        return "SHORT"
    return None

# =====================================================================
# دورة المسح — Scanning Cycle
# =====================================================================

def scan_symbols(exchange: ccxt.binanceusdm) -> dict | None:
    """
    مسح جميع الرموز للبحث عن إشارات صالحة.
    Returns the best signal dict or None.
    """
    print(f"\n  [مسح] بدء مسح {len(active_symbols)} رمزاً... ({datetime.now(timezone.utc).strftime('%H:%M:%S')} UTC)")
    candidates = []  # قائمة الإشارات المحتملة

    for i, symbol in enumerate(active_symbols):
        try:
            df = fetch_candles(exchange, symbol)
            if df is None:
                time.sleep(SYMBOL_DELAY)
                continue

            df = compute_indicators(df)
            signal = check_signal(df)

            if signal:
                # جلب حجم التداول للمقارنة
                ticker = api_call(exchange.fetch_ticker, symbol)
                vol = ticker.get("quoteVolume", 0) if ticker else 0
                candidates.append({
                    "symbol":    symbol,
                    "direction": signal,
                    "volume":    vol,
                    "price":     df.iloc[-1]["close"],
                })
                print(f"  [إشارة] {symbol} → {signal} | حجم: {vol:,.0f}")

        except Exception as e:
            print(f"  [تحذير] خطأ في مسح {symbol}: {e}")

        time.sleep(SYMBOL_DELAY)

    if not candidates:
        return None

    # اختيار الإشارة ذات أعلى حجم تداول
    best = max(candidates, key=lambda x: x["volume"])
    print(f"  [اختيار] أفضل إشارة: {best['symbol']} {best['direction']}")
    return best

# =====================================================================
# معلومات الرمز من البورصة — Symbol Market Info
# =====================================================================

def get_symbol_precision(exchange: ccxt.binanceusdm, symbol: str) -> tuple[int, int]:
    """
    الحصول على دقة الكمية والسعر للرمز من معلومات السوق
    Returns (amount_precision, price_precision)
    """
    try:
        market = exchange.market(symbol)
        amount_prec = market.get("precision", {}).get("amount", 3)
        price_prec  = market.get("precision", {}).get("price", 2)
        return int(amount_prec), int(price_prec)
    except Exception:
        return 3, 2


def round_down(value: float, decimals: int) -> float:
    """تقريب القيمة للأسفل بعدد المنازل العشرية المحددة"""
    factor = 10 ** decimals
    return math.floor(value * factor) / factor

# =====================================================================
# تنفيذ الصفقة — Trade Execution
# =====================================================================

def execute_trade(exchange: ccxt.binanceusdm, signal: dict) -> bool:
    """
    تنفيذ الصفقة كاملةً: تعيين الرافعة، إدخال السوق، وضع TP/SL
    Returns True on success, False on failure.
    """
    global current_trade, stats

    symbol    = signal["symbol"]
    direction = signal["direction"]
    side      = "buy" if direction == "LONG" else "sell"

    print(f"\n  [تنفيذ] بدء تنفيذ صفقة {direction} على {symbol}")

    # ─────────────────────────────────────────
    # 1. تعيين الرافعة المالية ونوع الهامش
    # ─────────────────────────────────────────
    try:
        exchange.set_leverage(LEVERAGE, symbol)
    except Exception as e:
        print(f"  [تخطي] فشل تعيين الرافعة لـ {symbol}: {e}")
        return False

    try:
        exchange.set_margin_mode("ISOLATED", symbol)
    except Exception as e:
        # بعض الأخطاء طبيعية إذا كان الوضع محدداً بالفعل
        if "already" not in str(e).lower() and "No need to change" not in str(e):
            print(f"  [تخطي] فشل تعيين نوع الهامش لـ {symbol}: {e}")
            return False

    # ─────────────────────────────────────────
    # 2. جلب الرصيد المتاح
    # ─────────────────────────────────────────
    balance_data = api_call(exchange.fetch_balance)
    if balance_data is None:
        print("  [خطأ] فشل جلب الرصيد.")
        return False

    free_usdt = balance_data.get("USDT", {}).get("free", 0)
    if free_usdt < MIN_BALANCE:
        print(f"  [تحذير حرج] الرصيد ${free_usdt:.2f} أقل من الحد الأدنى ${MIN_BALANCE}!")
        return False

    # ─────────────────────────────────────────
    # 3. حساب حجم المركز
    # ─────────────────────────────────────────
    ticker = api_call(exchange.fetch_ticker, symbol)
    if ticker is None:
        return False
    entry_estimate = ticker["last"]

    amount_prec, price_prec = get_symbol_precision(exchange, symbol)
    raw_size = (free_usdt * LEVERAGE) / entry_estimate
    size     = round_down(raw_size, amount_prec)

    if size <= 0:
        print(f"  [خطأ] حجم المركز صفر أو سالب: {size}")
        return False

    print(f"  [حجم] الرصيد: ${free_usdt:.2f} | حجم المركز: {size} @ ~${entry_estimate:.4f}")

    # ─────────────────────────────────────────
    # 4. تنفيذ أمر السوق
    # ─────────────────────────────────────────
    order = api_call(
        exchange.create_order,
        symbol,
        "market",
        side,
        size,
        params={"reduceOnly": False}
    )
    if order is None:
        print("  [خطأ] فشل تنفيذ أمر السوق.")
        return False

    # الانتظار للحصول على سعر التنفيذ الفعلي
    time.sleep(1)
    filled_order = api_call(exchange.fetch_order, order["id"], symbol)

    if filled_order and filled_order.get("average"):
        fill_price = float(filled_order["average"])
    elif filled_order and filled_order.get("price"):
        fill_price = float(filled_order["price"])
    else:
        fill_price = entry_estimate
        print(f"  [تحذير] استخدام السعر التقديري: ${fill_price}")

    print(f"  [تنفيذ] تم التنفيذ بسعر: ${fill_price:.6f}")

    # ─────────────────────────────────────────
    # 5. حساب TP و SL
    # ─────────────────────────────────────────
    if direction == "LONG":
        tp_price = round(fill_price * TP_PCT_LONG, price_prec)
        sl_price = round(fill_price * SL_PCT_LONG, price_prec)
    else:
        tp_price = round(fill_price * TP_PCT_SHORT, price_prec)
        sl_price = round(fill_price * SL_PCT_SHORT, price_prec)

    print(f"  [أهداف] TP: ${tp_price:.6f} | SL: ${sl_price:.6f}")

    # ─────────────────────────────────────────
    # 6. وضع أوامر TP و SL
    # ─────────────────────────────────────────
    close_side = "sell" if direction == "LONG" else "buy"
    tp_order_id = None
    sl_order_id = None

    try:
        tp_order = api_call(
            exchange.create_order,
            symbol,
            "TAKE_PROFIT_MARKET",
            close_side,
            size,
            params={
                "stopPrice":     tp_price,
                "reduceOnly":    True,
                "closePosition": True,
            }
        )
        if tp_order:
            tp_order_id = tp_order["id"]
            print(f"  [TP] تم وضع أمر Take Profit: #{tp_order_id}")
    except Exception as e:
        print(f"  [خطأ] فشل وضع TP: {e}")

    try:
        sl_order = api_call(
            exchange.create_order,
            symbol,
            "STOP_MARKET",
            close_side,
            size,
            params={
                "stopPrice":     sl_price,
                "reduceOnly":    True,
                "closePosition": True,
            }
        )
        if sl_order:
            sl_order_id = sl_order["id"]
            print(f"  [SL] تم وضع أمر Stop Loss: #{sl_order_id}")
    except Exception as e:
        print(f"  [خطأ] فشل وضع SL: {e}")

    # ─────────────────────────────────────────
    # 7. حفظ معلومات الصفقة في المتغير العالمي
    # ─────────────────────────────────────────
    current_trade = {
        "symbol":      symbol,
        "direction":   direction,
        "size":        size,
        "entry_price": fill_price,
        "tp_price":    tp_price,
        "sl_price":    sl_price,
        "tp_order_id": tp_order_id,
        "sl_order_id": sl_order_id,
        "entry_time":  time.time(),
        "open":        True,
    }

    return True

# =====================================================================
# مراقبة الصفقة — Trade Monitoring
# =====================================================================

def is_position_open(exchange: ccxt.binanceusdm, symbol: str) -> bool:
    """التحقق من أن المركز لا يزال مفتوحاً"""
    try:
        positions = api_call(exchange.fetch_positions, [symbol])
        if positions is None:
            return True  # افتراض أنه مفتوح في حال الشك
        for pos in positions:
            if pos.get("symbol") == symbol:
                contracts = abs(float(pos.get("contracts", 0) or 0))
                if contracts > 0:
                    return True
        return False
    except Exception:
        return True


def get_current_price(exchange: ccxt.binanceusdm, symbol: str) -> float:
    """جلب السعر الحالي"""
    ticker = api_call(exchange.fetch_ticker, symbol)
    if ticker:
        return float(ticker["last"])
    return 0.0


def cancel_tp_sl(exchange: ccxt.binanceusdm):
    """إلغاء أوامر TP و SL المعلقة"""
    global current_trade
    symbol = current_trade.get("symbol")
    if not symbol:
        return

    for order_key in ("tp_order_id", "sl_order_id"):
        order_id = current_trade.get(order_key)
        if order_id:
            try:
                api_call(exchange.cancel_order, order_id, symbol)
                print(f"  [إلغاء] تم إلغاء الأمر #{order_id}")
            except Exception as e:
                print(f"  [تحذير] فشل إلغاء الأمر #{order_id}: {e}")


def close_position_market(exchange: ccxt.binanceusdm):
    """إغلاق المركز المفتوح بأمر سوق"""
    global current_trade
    symbol    = current_trade.get("symbol")
    direction = current_trade.get("direction")
    size      = current_trade.get("size", 0)

    if not symbol or size <= 0:
        return

    close_side = "sell" if direction == "LONG" else "buy"
    try:
        api_call(
            exchange.create_order,
            symbol,
            "market",
            close_side,
            size,
            params={"reduceOnly": True}
        )
        print(f"  [إغلاق] تم إغلاق المركز بأمر سوق على {symbol}")
    except Exception as e:
        print(f"  [خطأ] فشل إغلاق المركز: {e}")


def monitor_trade(exchange: ccxt.binanceusdm):
    """
    مراقبة الصفقة المفتوحة حتى إغلاقها.
    يعود بعد إغلاق الصفقة (TP / SL / TIMEOUT).
    """
    global current_trade, stats

    symbol     = current_trade["symbol"]
    direction  = current_trade["direction"]
    entry_price = current_trade["entry_price"]
    tp_price   = current_trade["tp_price"]
    sl_price   = current_trade["sl_price"]
    entry_time = current_trade["entry_time"]
    size       = current_trade["size"]

    max_duration = MAX_TRADE_MINUTES * 60  # بالثواني
    close_reason = "TIMEOUT"
    close_price  = entry_price

    print(f"\n  [مراقبة] مراقبة صفقة {direction} على {symbol}...")
    print(f"  [مراقبة] سعر الدخول: ${entry_price:.6f} | TP: ${tp_price:.6f} | SL: ${sl_price:.6f}")

    while True:
        elapsed = time.time() - entry_time

        # ─── فحص انتهاء الوقت ───
        if elapsed >= max_duration:
            print(f"  [انتهاء الوقت] تجاوزت الصفقة 20 دقيقة — جاري الإغلاق...")
            cancel_tp_sl(exchange)
            close_position_market(exchange)
            close_price  = get_current_price(exchange, symbol)
            close_reason = "TIMEOUT"
            break

        # ─── فحص حالة المركز ───
        position_open = is_position_open(exchange, symbol)
        if not position_open:
            # المركز أُغلق بواسطة TP أو SL
            close_price_now = get_current_price(exchange, symbol)

            # تحديد سبب الإغلاق بناءً على الاتجاه والسعر
            if direction == "LONG":
                if close_price_now >= tp_price * 0.999:
                    close_reason = "TP"
                    close_price  = tp_price
                else:
                    close_reason = "SL"
                    close_price  = sl_price
            else:
                if close_price_now <= tp_price * 1.001:
                    close_reason = "TP"
                    close_price  = tp_price
                else:
                    close_reason = "SL"
                    close_price  = sl_price

            # إلغاء أي أوامر متبقية
            cancel_tp_sl(exchange)
            print(f"  [إغلاق] الصفقة أُغلقت بواسطة: {close_reason} | السعر: ${close_price:.6f}")
            break

        # ─── طباعة الحالة كل دقيقة ───
        remaining = max_duration - elapsed
        mins = int(remaining // 60)
        secs = int(remaining % 60)
        cur_price = get_current_price(exchange, symbol)
        print(f"  [مراقبة] السعر الحالي: ${cur_price:.6f} | الوقت المتبقي: {mins}د {secs}ث")

        time.sleep(POSITION_POLL)

    # ─────────────────────────────────────────
    # حساب الأرباح والخسائر وتحديث الرصيد
    # ─────────────────────────────────────────
    if direction == "LONG":
        pnl_pct = (close_price - entry_price) / entry_price
    else:
        pnl_pct = (entry_price - close_price) / entry_price

    pnl_usdt = pnl_pct * size * entry_price  # تقريبي بدون رسوم

    # تحديث الإحصائيات
    stats["total_trades"] += 1
    stats["total_pnl"]    += pnl_usdt

    if close_reason == "TP":
        stats["wins"] += 1
    elif close_reason == "SL":
        stats["losses"] += 1
    else:
        stats["timeouts"] += 1

    # جلب الرصيد المحدّث من البورصة
    balance_data = api_call(exchange.fetch_balance)
    if balance_data:
        stats["balance"] = balance_data.get("USDT", {}).get("total", stats["balance"] + pnl_usdt)
    else:
        stats["balance"] += pnl_usdt

    print(f"\n  ══════════════════════════════════════")
    print(f"  [نتيجة] سبب الإغلاق : {close_reason}")
    print(f"  [نتيجة] ربح/خسارة   : ${pnl_usdt:+.4f}  ({pnl_pct*100:+.4f}%)")
    print(f"  [نتيجة] الرصيد الجديد: ${stats['balance']:.2f}")
    print(f"  ══════════════════════════════════════\n")

    # تسجيل الصفقة في CSV
    log_trade(
        symbol, direction, entry_price, close_price,
        close_reason, pnl_usdt, pnl_pct * 100, stats["balance"]
    )

    # إعادة تعيين حالة الصفقة
    current_trade = {}

    # طباعة اللوحة بعد كل صفقة
    print_dashboard()

# =====================================================================
# لوحة التحكم الطرفية — Terminal Dashboard
# =====================================================================

def print_dashboard():
    """
    طباعة لوحة التحكم الكاملة باستخدام رموز Unicode
    Prints the full dashboard to the terminal.
    """
    global last_dashboard_print
    last_dashboard_print = time.time()

    # ─── حساب الإحصائيات ───
    total   = stats["total_trades"]
    wins    = stats["wins"]
    losses  = stats["losses"]
    timeouts = stats["timeouts"]
    balance  = stats["balance"]
    total_pnl = stats["total_pnl"]
    pnl_pct_total = ((balance - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100) if INITIAL_CAPITAL > 0 else 0

    win_pct  = (wins / total * 100)    if total > 0 else 0.0
    loss_pct = (losses / total * 100)  if total > 0 else 0.0

    pnl_sign = "+" if total_pnl >= 0 else ""

    # ─── حالة الصفقة الحالية ───
    in_trade  = bool(current_trade)
    status    = "IN TRADE" if in_trade else "SCANNING"
    sym_disp  = current_trade.get("symbol", "---")
    dir_disp  = current_trade.get("direction", "---")
    entry_disp = f"${current_trade['entry_price']:.2f}" if in_trade else "---"
    tp_disp   = f"${current_trade['tp_price']:.2f} (+2.0%)" if in_trade else "---"
    sl_disp   = f"${current_trade['sl_price']:.2f} (-0.7%)" if in_trade else "---"

    if in_trade:
        elapsed   = time.time() - current_trade.get("entry_time", time.time())
        remaining = max(0, MAX_TRADE_MINUTES * 60 - elapsed)
        r_min     = int(remaining // 60)
        r_sec     = int(remaining % 60)
        time_disp = f"{r_min} دقيقة {r_sec} ثانية"
    else:
        time_disp = "---"

    # ─── تنسيق عدد الرموز ───
    sym_count = len(active_symbols)

    # ─── طباعة اللوحة ───
    W = 52  # عرض الصندوق الداخلي
    def row(content: str) -> str:
        # دعم النص العربي (يُعرض من اليمين لليسار في الطرفية)
        return f"║  {content:<{W - 4}}║"

    print()
    print("╔" + "═" * W + "╗")
    print("║" + "      🔪 THE SURGEON BOT — LIVE".center(W) + "║")
    print("╠" + "═" * W + "╣")
    print(row(f"الرصيد الحالي      : ${balance:.2f} USDT"))
    print(row(f"رأس المال الأولي   : ${INITIAL_CAPITAL:.2f}"))
    print(row(f"إجمالي الربح/خسارة : {pnl_sign}${total_pnl:.2f}  ({pnl_sign}{pnl_pct_total:.2f}%)"))
    print("╠" + "═" * W + "╣")
    print(row(f"إجمالي الصفقات     : {total}"))
    print(row(f"صفقات رابحة        : {wins}  ({win_pct:.1f}%)"))
    print(row(f"صفقات خاسرة        : {losses}  ({loss_pct:.1f}%)"))
    print(row(f"إغلاق بالوقت       : {timeouts}"))
    print("╠" + "═" * W + "╣")
    print(row(f"الحالة             : {status}"))
    print(row(f"الرمز الحالي       : {sym_disp}"))
    print(row(f"الاتجاه            : {dir_disp}"))
    print(row(f"سعر الدخول         : {entry_disp}"))
    print(row(f"هدف الربح          : {tp_disp}"))
    print(row(f"وقف الخسارة        : {sl_disp}"))
    print(row(f"الوقت المتبقي      : {time_disp}"))
    print(row(f"الرموز المراقبة    : {sym_count}"))
    print("╚" + "═" * W + "╝")
    print()

# =====================================================================
# لافتة الإطلاق — Startup Banner
# =====================================================================

def print_banner():
    """طباعة لافتة البداية مع معلومات التهيئة"""
    mode = "🧪 TESTNET (تجريبي)" if TESTNET else "🔴 LIVE (حقيقي)"
    print()
    print("╔══════════════════════════════════════════════════════╗")
    print("║          🔪 THE SURGEON BOT — جراح العملات          ║")
    print("║          Binance Futures Scalping Bot v1.0           ║")
    print("╠══════════════════════════════════════════════════════╣")
    print(f"║  الوضع : {mode:<44}║")
    print(f"║  رأس المال الأولي  : ${INITIAL_CAPITAL:<37}║")
    print(f"║  الرافعة المالية   : {LEVERAGE}x{'':<38}║")
    print(f"║  الإطار الزمني     : {TIMEFRAME:<37}║")
    print(f"║  الهدف             : +2.0% | وقف الخسارة: -0.7%{'':<5}║")
    print(f"║  مدة الصفقة القصوى : {MAX_TRADE_MINUTES} دقيقة{'':<38}║")
    print("╚══════════════════════════════════════════════════════╝")
    print()

# =====================================================================
# المعالجة عند الإنهاء — Graceful Shutdown
# =====================================================================

def graceful_shutdown(exchange: ccxt.binanceusdm):
    """
    إغلاق نظيف عند Ctrl+C:
    إلغاء أوامر TP/SL، إغلاق المركز المفتوح بالسوق، حفظ السجلات
    """
    print("\n\n  [إيقاف] تم استلام إشارة الإيقاف (Ctrl+C)...")
    print("  [إيقاف] جاري إغلاق الصفقات المفتوحة...")

    if current_trade:
        cancel_tp_sl(exchange)
        time.sleep(1)
        close_position_market(exchange)
        time.sleep(1)

        # تسجيل الصفقة المغلقة يدوياً
        symbol     = current_trade.get("symbol", "")
        direction  = current_trade.get("direction", "")
        entry_price = current_trade.get("entry_price", 0)
        close_price = get_current_price(exchange, symbol) if symbol else 0

        if direction and entry_price and close_price:
            if direction == "LONG":
                pnl_pct = (close_price - entry_price) / entry_price
            else:
                pnl_pct = (entry_price - close_price) / entry_price

            size     = current_trade.get("size", 0)
            pnl_usdt = pnl_pct * size * entry_price

            log_trade(symbol, direction, entry_price, close_price,
                      "MANUAL_CLOSE", pnl_usdt, pnl_pct * 100, stats["balance"] + pnl_usdt)

    print("  [إيقاف] تم الإغلاق النظيف. وداعاً! 👋")
    sys.exit(0)

# =====================================================================
# الحلقة الرئيسية — Main Loop
# =====================================================================

def main():
    """
    النقطة الرئيسية لتشغيل البوت.
    Main entry point — runs the bot loop forever.
    """
    global active_symbols, symbols_last_updated, stats

    # ─── طباعة اللافتة ───
    print_banner()

    # ─── تهيئة ملف السجل ───
    init_log()

    # ─── إنشاء الاتصال بالبورصة ───
    print("  [اتصال] جاري الاتصال ببورصة Binance Futures...")
    try:
        exchange = create_exchange()
        print("  [اتصال] تم الاتصال بنجاح!")
    except Exception as e:
        print(f"  [خطأ فادح] فشل الاتصال بالبورصة: {e}")
        sys.exit(1)

    # ─── جلب الرصيد الأولي ───
    try:
        balance_data = api_call(exchange.fetch_balance)
        if balance_data:
            actual_balance = balance_data.get("USDT", {}).get("total", INITIAL_CAPITAL)
            stats["balance"] = actual_balance
            print(f"  [رصيد] الرصيد الحالي: ${actual_balance:.2f} USDT")
    except Exception as e:
        print(f"  [تحذير] فشل جلب الرصيد الأولي: {e}")

    # ─── تحميل قائمة الرموز ───
    active_symbols = fetch_top_symbols(exchange)
    symbols_last_updated = time.time()

    if not active_symbols:
        print("  [خطأ فادح] فشل تحميل قائمة الرموز!")
        sys.exit(1)

    print(f"  [جاهز] تم تحميل {len(active_symbols)} رمزاً. البوت يعمل الآن!")
    print_dashboard()

    # ─── الحلقة الرئيسية اللانهائية ───
    try:
        while True:
            # ── تحديث قائمة الرموز كل 4 ساعات ──
            maybe_refresh_symbols(exchange)

            # ── فحص الرصيد الحرج ──
            balance_data = api_call(exchange.fetch_balance)
            if balance_data:
                current_usdt = balance_data.get("USDT", {}).get("free", stats["balance"])
                stats["balance"] = balance_data.get("USDT", {}).get("total", stats["balance"])
                if current_usdt < MIN_BALANCE:
                    print(f"\n  [تحذير حرج] ⚠️  الرصيد ${current_usdt:.2f} أقل من الحد الأدنى ${MIN_BALANCE}!")
                    print("  [إيقاف] تم إيقاف التداول بسبب انخفاض الرصيد.")
                    print_dashboard()
                    break

            # ── إذا لا توجد صفقة مفتوحة، ابحث عن إشارة ──
            if not current_trade:
                signal = scan_symbols(exchange)

                if signal:
                    success = execute_trade(exchange, signal)
                    if success:
                        # مراقبة الصفقة حتى إغلاقها
                        monitor_trade(exchange)
                    else:
                        print(f"  [تحذير] فشل تنفيذ الصفقة على {signal['symbol']}")
                        time.sleep(5)
                else:
                    print(f"  [مسح] لم يُعثر على إشارات — الانتظار {SCAN_INTERVAL} ثانية...")
                    # طباعة اللوحة كل 5 دقائق
                    if time.time() - last_dashboard_print >= DASHBOARD_INTERVAL:
                        print_dashboard()
                    time.sleep(SCAN_INTERVAL)
            else:
                # في حال غير متوقع — مراقبة الصفقة القائمة
                monitor_trade(exchange)

    except KeyboardInterrupt:
        graceful_shutdown(exchange)
    except Exception as e:
        print(f"\n  [خطأ فادح] خطأ غير متوقع في الحلقة الرئيسية: {e}")
        traceback.print_exc()
        # محاولة إغلاق نظيف
        try:
            graceful_shutdown(exchange)
        except Exception:
            sys.exit(1)


# =====================================================================
# نقطة الدخول — Entry Point
# =====================================================================

if __name__ == "__main__":
    main()
