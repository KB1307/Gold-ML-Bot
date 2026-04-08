# XAUUSD Signal Bot - System Documentation

## System Overview

This is an AI-powered gold (XAUUSD) trading signal application built with React Native and Expo. The app generates high-confidence trading signals using a simulated Transformer-based deep learning model with reinforcement learning capabilities.

## How the System Operates

### 1. Signal Generation Engine

**Location**: `services/signalEngine.ts`

The signal generation system uses a multi-layered analysis approach:

#### Market Feature Extraction
- **Asian Session High/Low**: Identifies key support/resistance levels from the Asian trading session (00:00-06:00 UTC)
- **Daily Pivot Points**: Calculates Classic Pivot Points (P, R1-R3, S1-S3) using Fibonacci ratios
- **Technical Indicators**:
  - RSI (Relative Strength Index): Momentum oscillator for overbought/oversold conditions
  - ATR (Average True Range): Volatility measurement
- **Intermarket Analysis**:
  - DXY (US Dollar Index): Gold has inverse correlation with USD
  - Volume Ratio: Institutional order flow analysis

#### Transformer Analysis (Simulated)
The `transformerAnalysis()` function mimics a Transformer-based neural network that:

1. **Session Weighting**: Gives higher signal strength during London session (06:00-13:00 UTC)
2. **Trend Recognition**: Analyzes price position relative to Asian High and Daily Pivot
3. **Momentum Confirmation**: Uses RSI to confirm trend direction
4. **Intermarket Validation**: Checks DXY movement for correlation
5. **Volume Confirmation**: Validates institutional participation

**Signal Confidence Calculation**:
```
Base Confidence = 0.65
+ London Session Boost (0.3)
+ Asian Range Position (0.2)
+ RSI Confirmation (0.15)
+ DXY Correlation (0.2)
+ Volume Ratio (0.15)
+ Random Variance (-0.05 to +0.05)
= Final Confidence (55% - 98%)
```

### 2. Market Awareness

**Market Hours**:
- **Open**: Monday 00:00 UTC - Friday 21:00 UTC
- **Closed**: Weekend (Friday 21:00 - Sunday 22:00 UTC)

**Trading Sessions**:
- **Asian**: 00:00 - 06:00 UTC (Low volatility, range-bound)
- **London**: 06:00 - 13:00 UTC (Highest signal generation, trend continuation)
- **New York**: 13:00 - 21:00 UTC (Consolidation/reversal)

The system **DOES NOT** generate signals when markets are closed.

### 3. Analysis Engines Used

#### Primary Engines:
1. **Transformer Encoder Block** (Simulated)
   - Processes non-linear relationships in time-series data
   - Captures long-term dependencies without sequential processing
   - Multi-head attention for different market features

2. **Multi-Modal Fusion Layer**
   - Separate processing streams for Price, Volume, and Intermarket data
   - Specialized sub-networks for each feature category
   - Fusion layer combines outputs for final prediction

3. **Reinforcement Learning Module**
   - Online learning from live signal outcomes
   - Reward function penalizes excessive drawdown and slow TP hits
   - Continuous weight adjustment based on performance

#### Supporting Systems:
- **Walk-Forward Optimization**: Dynamic training window (typically 12 weeks)
- **Drift Detection**: Automatically adjusts training data based on market regime changes
- **Confidence Scoring**: Multi-class classification (Strong Trend / Range-Bound / Loss)

### 4. Signal Lifecycle

```
1. Market Opens → Engine Activated
2. Feature Extraction → Asian High/Low, Pivots, RSI, ATR, DXY
3. Transformer Analysis → Signal Strength & Confidence Calculation
4. Confidence Filter → Only signals ≥ minConfidence threshold
5. Signal Generated → BUY/SELL with TP1, TP2, TP3, SL levels
6. Active Monitoring → Real-time price tracking against targets
7. Target Hit Detection → Updates status when TP1/TP2/TP3/SL reached
8. Signal Closure → Moved to history, data fed back to learning engine
9. Model Re-training → Weights adjusted based on outcome
```

### 5. Signal Parameters

**Default Configuration** (Adjustable in Settings):
- **TP1**: 15 pips (1.5 XAUUSD points)
- **TP2**: 30 pips (3.0 XAUUSD points)
- **TP3**: 100 pips (10.0 XAUUSD points)
- **Stop Loss**: 120 pips (12.0 XAUUSD points)
- **Minimum Confidence**: 70%

**Note**: 1 pip = 0.1 in XAUUSD pricing

### 6. Learning Mechanism

#### Active Testing:
- Each signal is tested in real-time against live market (simulated)
- Outcome (TP3 Hit / SL Hit / Partial TPs) is recorded

#### Memory & Adaptation:
- **Signal History**: All closed signals stored in AsyncStorage
- **Learning Database**: Separate persistent storage (simulated) keeps ALL signals
- **User History Deletion**: Only removes from UI, not from learning database

#### Continuous Learning:
- **High-Frequency Updates**: Successful signals trigger immediate weight fine-tuning
- **Weekly Re-training**: Full Walk-Forward cycle every week
- **Performance Degradation Triggers**: Auto-retrains if win-rate drops for 2 consecutive days
- **High Volatility Events**: Retrains after major news events (NFP, CPI, FOMC)

### 7. App Features

#### Dashboard Tab:
- Current live price
- Active signal with confidence score
- Real-time TP/SL progress tracking
- P/L calculation
- Market session status

#### Market Outlook Tab:
- Market open/closed status
- Active trading sessions
- Trend direction (Bullish/Bearish/Neutral)
- Volatility level (Low/Medium/High)
- Daily pivot points (R1-R3, Pivot, S1-S3)

#### History Tab:
- All closed signals
- Success rate (TP hits vs SL hits)
- Individual signal performance
- Delete signals from view (not from learning engine)

#### Settings Tab:
- Adjust TP1, TP2, TP3 levels
- Configure Stop Loss distance
- Set minimum confidence threshold
- Choose number of TP levels (1, 2, or 3)
- Toggle notifications

### 8. Technical Architecture

**State Management**:
- `@nkzw/create-context-hook`: React Context with hooks
- `AsyncStorage`: Persistent storage for settings and history
- Real-time updates: 2-5 second intervals

**Signal Generation**:
- Every 30 seconds while logged in and market open
- Prevents overlapping signals (only 1 active signal at a time)
- No BUY/SELL conflicts (closes previous before generating new)

**Price Simulation**:
- Time-based price generation with realistic patterns
- London/NY session boosts
- Daily variance + hourly cycles + random noise

### 9. Debug & Testing

**Console Logging**:
- Signal generation events
- Market status changes
- Target hit notifications
- Model decision reasoning

**Test Scenarios**:
1. Market closed → No signals generated
2. Low confidence (< 70%) → Signal rejected
3. Active signal exists → No new signal until closed
4. TP levels hit → Status updates in real-time
5. SL hit → Signal closed, moved to history

### 10. Future Enhancements (V2.0)

- Live chart integration (TradingView)
- Push notifications for signals
- Multiple currency pair support
- Social trading / signal sharing
- Performance analytics dashboard
- ML model versioning & A/B testing
- Real broker API integration

---

## Point-Form System Operation Summary

1. **User logs in** → Trading context initialized
2. **Market status checked** → UTC time-based open/close detection
3. **Signal generation starts** → 30-second intervals
4. **Market features extracted**:
   - Asian session range
   - Daily pivot points
   - RSI, ATR indicators
   - DXY correlation
   - Volume ratio
5. **Transformer analysis performed**:
   - Session-weighted scoring
   - Trend direction analysis
   - Confidence calculation
6. **Signal filtered** → Must meet minimum confidence threshold
7. **Signal displayed** → Dashboard shows TP/SL levels with confidence
8. **Real-time monitoring** → Price checked every 2 seconds
9. **Target detection** → TP1/TP2/TP3/SL hit events
10. **Signal closure** → Moved to history
11. **Learning feedback** → Outcome fed to ML model
12. **Model adaptation** → Weights updated for future signals
13. **Walk-forward optimization** → Weekly full retraining cycle

## Analysis Engines Summary

- **Transformer Encoder Block**: Non-linear time-series pattern recognition
- **Multi-Modal Fusion Layer**: Specialized feature processing
- **Reinforcement Learning**: Continuous adaptation from outcomes
- **Walk-Forward System**: Dynamic training window with drift detection
- **Confidence Scoring**: Multi-class risk assessment
- **Session Analysis**: London/NY/Asian session-specific logic
- **Pivot Point Calculator**: Classic Fibonacci-based S/R levels
- **Intermarket Correlation**: DXY inverse relationship tracking
- **Volume Profile**: Institutional order flow detection
- **RSI Momentum Filter**: Trend confirmation system

---

**Disclaimer**: This is a demonstration/educational application. Trading signals are simulated and should not be used for live trading without proper backtesting and risk management.
