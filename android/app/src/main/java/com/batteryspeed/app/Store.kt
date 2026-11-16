package com.batteryspeed.app

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class Point(val ts: Long, val percent: Int, val milliwatts: Int?, val plugged: Boolean, val state: String)
data class SavedAlert(val ts: Long, val severity: String, val title: String, val body: String)

/** History and alerts, kept in a small database on the phone. */
class Store private constructor(context: Context) :
    SQLiteOpenHelper(context, "battery.db", null, 1) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE samples (
                 ts INTEGER PRIMARY KEY, percent INTEGER, milliwatts INTEGER,
                 plugged INTEGER NOT NULL, state TEXT)""",
        )
        db.execSQL("CREATE TABLE alerts (ts INTEGER NOT NULL, severity TEXT, title TEXT, body TEXT)")
    }

    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) = Unit

    private var lastKey: String? = null
    private var lastSaved = 0L

    /** Saves a reading if something changed, or once a minute regardless. */
    @Synchronized
    fun record(r: Reading, v: Verdict) {
        val mw = r.watts?.let { (it * 1000).toInt() }
        val key = "${r.percent}|${r.plugged}|${v.state}|${mw?.div(250)}"
        if (key == lastKey && r.ts - lastSaved < 60_000) return
        writableDatabase.insertWithOnConflict(
            "samples", null,
            ContentValues().apply {
                put("ts", r.ts); put("percent", r.percent); put("milliwatts", mw)
                put("plugged", if (r.plugged) 1 else 0); put("state", v.state.name)
            },
            SQLiteDatabase.CONFLICT_REPLACE,
        )
        lastKey = key
        lastSaved = r.ts
        // Keep 30 days.
        if (r.ts % 50 == 0L) writableDatabase.delete("samples", "ts < ?", arrayOf((r.ts - 30L * 86_400_000).toString()))
    }

    fun history(sinceTs: Long): List<Point> =
        readableDatabase.rawQuery(
            "SELECT ts, percent, milliwatts, plugged, state FROM samples WHERE ts >= ? ORDER BY ts",
            arrayOf(sinceTs.toString()),
        ).use { c ->
            buildList {
                while (c.moveToNext()) {
                    add(Point(c.getLong(0), c.getInt(1), if (c.isNull(2)) null else c.getInt(2), c.getInt(3) == 1, c.getString(4)))
                }
            }
        }

    fun addAlert(a: SavedAlert) {
        writableDatabase.insert("alerts", null, ContentValues().apply {
            put("ts", a.ts); put("severity", a.severity); put("title", a.title); put("body", a.body)
        })
    }

    fun recentAlerts(limit: Int = 20): List<SavedAlert> =
        readableDatabase.rawQuery("SELECT ts, severity, title, body FROM alerts ORDER BY ts DESC LIMIT $limit", null).use { c ->
            buildList { while (c.moveToNext()) add(SavedAlert(c.getLong(0), c.getString(1), c.getString(2), c.getString(3))) }
        }

    companion object {
        @Volatile private var instance: Store? = null
        fun get(context: Context): Store =
            instance ?: synchronized(this) { instance ?: Store(context.applicationContext).also { instance = it } }
    }
}

/** Totals for a period, for the History screen. */
data class PeriodStats(val onBatteryMin: Int, val usedPct: Int, val chargedPct: Int, val avgDrainW: Double?, val lowest: Int?)

fun summarise(points: List<Point>): PeriodStats {
    var onBatteryMs = 0L
    var used = 0
    var charged = 0
    var drainMwMs = 0.0
    var drainMs = 0L
    points.zipWithNext { a, b ->
        val gap = b.ts - a.ts
        if (gap > 120_000) return@zipWithNext // asleep or switched off: not counted
        if (!a.plugged) {
            onBatteryMs += gap
            if (a.milliwatts != null && a.milliwatts < 0) {
                drainMwMs += -a.milliwatts.toDouble() * gap
                drainMs += gap
            }
        }
        val change = b.percent - a.percent
        if (change < 0) used -= change else charged += change
    }
    return PeriodStats(
        onBatteryMin = (onBatteryMs / 60_000).toInt(),
        usedPct = used,
        chargedPct = charged,
        avgDrainW = if (drainMs > 0) drainMwMs / drainMs / 1000 else null,
        lowest = points.minOfOrNull { it.percent },
    )
}
