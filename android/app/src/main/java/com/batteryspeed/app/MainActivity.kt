package com.batteryspeed.app

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date
import kotlin.math.abs

// Fixed status colors, the same family as the desktop app's.
private val Good = Color(0xFF34C759)
private val Warn = Color(0xFFFF9F0A)
private val Bad = Color(0xFFFF3B30)
private val InColor = Color(0xFF0A84FF)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Channels.create(this)
        if (Settings(this).monitoring) MonitorService.start(this)
        setContent { BatterySpeedTheme { App() } }
    }
}

@Composable
private fun BatterySpeedTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val context = LocalContext.current
    // Material You: the app takes its colors from the phone's wallpaper (Android 12+).
    val scheme: ColorScheme = when {
        Build.VERSION.SDK_INT >= 31 && dark -> dynamicDarkColorScheme(context)
        Build.VERSION.SDK_INT >= 31 -> dynamicLightColorScheme(context)
        dark -> darkColorScheme(primary = Good)
        else -> lightColorScheme(primary = Color(0xFF1F8A3B))
    }
    MaterialTheme(colorScheme = scheme, content = content)
}

private enum class Tab(val label: String, val icon: Int) {
    Overview("Overview", R.drawable.ic_battery),
    History("History", R.drawable.ic_chart),
    Health("Health", R.drawable.ic_heart),
    Alerts("Alerts", R.drawable.ic_settings),
}

@Composable
private fun App() {
    val context = LocalContext.current
    var tab by rememberSaveable { mutableStateOf(Tab.Overview) }
    val estimator = remember { Estimator() }
    var reading by remember { mutableStateOf(BatteryReader.read(context)) }
    var verdict by remember { mutableStateOf(estimator.update(reading)) }

    // Notifications are needed for alerts and the status readout (Android 13+ asks).
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
    // Live while the app is open: a new reading every two seconds.
    LaunchedEffect(Unit) {
        while (true) {
            reading = BatteryReader.read(context)
            verdict = estimator.update(reading)
            delay(2000)
        }
    }

    Scaffold(
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = { Icon(painterResource(t.icon), contentDescription = null) },
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(tab.label, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
            when (tab) {
                Tab.Overview -> Overview(reading, verdict)
                Tab.History -> HistoryScreen(reading)
                Tab.Health -> HealthScreen(reading)
                Tab.Alerts -> AlertsScreen()
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

// ---------------------------------------------------------------- overview

@Composable
private fun Overview(r: Reading, v: Verdict) {
    val stateColor = when (v.severity) {
        Severity.GOOD -> Good
        Severity.WARNING -> Warn
        Severity.CRITICAL -> Bad
        Severity.NEUTRAL -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    painterResource(
                        when (v.state) {
                            State.CHARGING -> R.drawable.ic_bolt
                            State.DRAINING_ON_CHARGER -> R.drawable.ic_warning
                            State.FULL -> R.drawable.ic_check
                            State.HOLDING -> R.drawable.ic_pause
                            State.ON_BATTERY -> R.drawable.ic_battery
                        },
                    ),
                    contentDescription = null,
                    tint = stateColor,
                    modifier = Modifier.size(20.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(v.headline, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            }
            Row(verticalAlignment = Alignment.Bottom) {
                Text("${r.percent}", fontSize = 56.sp, fontWeight = FontWeight.Bold, lineHeight = 56.sp)
                Text("%", fontSize = 26.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(bottom = 8.dp))
                Spacer(Modifier.weight(1f))
                if (v.etaMin != null) {
                    Column(horizontalAlignment = Alignment.End) {
                        Text(duration(v.etaMin), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        Text(if (v.etaKind == "full") "until full" else "remaining", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            LinearProgressIndicator(
                progress = { r.percent / 100f },
                modifier = Modifier.fillMaxWidth().height(8.dp),
                color = stateColor,
                strokeCap = StrokeCap.Round,
                drawStopIndicator = {},
            )
        }
    }

    // Where the power is going, as labeled boxes with the number in each.
    val watts = r.watts
    val flow = when {
        watts == null || abs(watts) < 0.05 -> "resting"
        watts > 0 -> "in"
        else -> "out"
    }
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        PowerBox(
            modifier = Modifier.weight(1f),
            color = if (r.plugged) InColor else MaterialTheme.colorScheme.outline,
            eyebrow = if (r.plugged) "CHARGER" else "NO CHARGER",
            value = r.plug.label,
            note = if (r.plugged) "Android doesn't tell apps how many watts it gives." else "The battery runs the phone.",
            big = false,
        )
        PowerBox(
            modifier = Modifier.weight(1f),
            color = when (flow) { "in" -> Good; "out" -> Warn; else -> MaterialTheme.colorScheme.outline },
            eyebrow = when (flow) { "in" -> "GOING INTO BATTERY"; "out" -> "COMING OUT OF BATTERY"; else -> "BATTERY RESTING" },
            value = watts?.let { "${"%.1f".format(abs(it))} W" } ?: "Not reported",
            note = r.currentMa?.let { "${"%,d".format(abs(it))} mA ${if (it >= 0) "in" else "out"}" }
                ?: "This phone doesn't report current.",
            big = true,
        )
    }
    if (!r.plugged && watts != null) {
        Text(
            "On battery, what comes out of the battery is what the phone is using: ${"%.1f".format(abs(watts))} W.",
            style = MaterialTheme.typography.bodyMedium,
        )
    }
    Text(v.meaning, style = MaterialTheme.typography.bodyLarge)
    Text(
        "W means watts: how fast power is flowing at this moment. A bigger number is more power.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    SectionTitle("Details")
    Rows(
        "Charge" to (r.chargeMah?.let { mah -> "${r.percent}% · ${"%,d".format(mah)}${r.fullMah?.let { " of ${"%,d".format(it)}" } ?: ""} mAh" } ?: "${r.percent}%"),
        "Voltage" to (r.voltageMv?.let { "${"%.2f".format(it / 1000.0)} V" } ?: "Not reported"),
        "Temperature" to (r.tempC?.let { "${"%.1f".format(it)} °C" } ?: "Not reported"),
        "Battery saver" to if (r.powerSaver) "On" else "Off",
    )
    Footnote(
        "Android does not let apps see how much power the charger gives, the phone's total use while plugged in, or which apps use the most energy. " +
            "Everything shown here stays on this phone.",
    )
}

@Composable
private fun PowerBox(modifier: Modifier, color: Color, eyebrow: String, value: String, note: String, big: Boolean) {
    Card(modifier.fillMaxHeight(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh)) {
        Box(Modifier.fillMaxWidth().height(3.dp).padding(horizontal = 0.dp)) {
            Canvas(Modifier.fillMaxSize()) { drawRect(color) }
        }
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(eyebrow, color = color, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
            Text(
                value,
                style = if (big) MaterialTheme.typography.headlineSmall else MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            Text(note, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

// ---------------------------------------------------------------- history

@Composable
private fun HistoryScreen(latest: Reading) {
    val context = LocalContext.current
    var hours by rememberSaveable { mutableIntStateOf(24) }
    var points by remember { mutableStateOf(emptyList<Point>()) }
    LaunchedEffect(hours, latest.ts / 60_000) {
        points = Store.get(context).history(System.currentTimeMillis() - hours * 3_600_000L)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf(6, 24, 168).forEach { h ->
            FilterChip(selected = hours == h, onClick = { hours = h }, label = { Text(if (h == 168) "7 days" else "$h hours") })
        }
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            Text("Charge level", style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.height(8.dp))
            LevelChart(points, hours)
        }
    }
    val stats = summarise(points)
    SectionTitle("In this period")
    Rows(
        "On battery" to if (stats.onBatteryMin > 0) duration(stats.onBatteryMin) else "None",
        "Charge used" to "${stats.usedPct}%",
        "Charge added" to "${stats.chargedPct}%",
        "Average use on battery" to (stats.avgDrainW?.let { "${"%.1f".format(it)} W" } ?: "Not enough data"),
        "Lowest level" to (stats.lowest?.let { "$it%" } ?: "–"),
    )
    Footnote(
        if (Settings(context).monitoring) "Recorded in the background while monitoring is on (Alerts tab). Gaps are times the phone was off."
        else "Background monitoring is off, so history is only recorded while the app is open.",
    )
}

@Composable
private fun LevelChart(points: List<Point>, hours: Int) {
    val measurer = rememberTextMeasurer()
    val line = MaterialTheme.colorScheme.primary
    val grid = MaterialTheme.colorScheme.outlineVariant
    val label = MaterialTheme.colorScheme.onSurfaceVariant
    Canvas(Modifier.fillMaxWidth().height(180.dp)) {
        val left = 34.dp.toPx()
        val bottom = size.height - 6.dp.toPx()
        val top = 6.dp.toPx()
        val width = size.width - left
        val now = System.currentTimeMillis()
        val start = now - hours * 3_600_000L
        for (pct in listOf(0, 50, 100)) {
            val y = bottom - (bottom - top) * pct / 100f
            drawLine(grid, Offset(left, y), Offset(size.width, y), strokeWidth = 1f)
            drawText(measurer, "$pct", Offset(0f, y - 8.sp.toPx()), TextStyle(color = label, fontSize = 11.sp))
        }
        if (points.size < 2) {
            drawText(measurer, "Collecting readings…", Offset(left + 8.dp.toPx(), bottom / 2), TextStyle(color = label, fontSize = 13.sp))
            return@Canvas
        }
        val path = Path()
        var previous: Point? = null
        points.forEach { p ->
            val x = left + width * ((p.ts - start).toFloat() / (now - start))
            val y = bottom - (bottom - top) * p.percent / 100f
            // Break the line where the phone was off or asleep without readings.
            if (previous == null || p.ts - previous!!.ts > 30 * 60_000) path.moveTo(x, y) else path.lineTo(x, y)
            previous = p
        }
        drawPath(path, line, style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round))
    }
}

// ---------------------------------------------------------------- health

@Composable
private fun HealthScreen(r: Reading) {
    Rows(
        "Condition" to r.health,
        "Charge cycles" to (r.cycles?.let { "%,d".format(it) } ?: "Not reported (Android 14 and later)"),
        "Full charge holds" to (r.fullMah?.let { "about ${"%,d".format(it)} mAh" } ?: "Not reported"),
        "Temperature" to (r.tempC?.let { "${"%.1f".format(it)} °C${if (it >= 40) " · running hot" else ""}" } ?: "Not reported"),
        "Voltage" to (r.voltageMv?.let { "${"%.2f".format(it / 1000.0)} V" } ?: "Not reported"),
    )
    Footnote(
        "Android does not tell apps how much the battery held when new, so the health percentage your phone's own settings may show can't be worked out here. " +
            "One charge cycle is a full 100% of charge used, even across several top-ups. Batteries age faster when they stay hot or full.",
    )
}

// ---------------------------------------------------------------- alerts and settings

@Composable
private fun AlertsScreen() {
    val context = LocalContext.current
    val settings = remember { Settings(context) }
    var monitoring by remember { mutableStateOf(settings.monitoring) }
    var alerts by remember { mutableStateOf(settings.alerts) }
    var unplugAt by remember { mutableIntStateOf(settings.unplugAt) }
    var saved by remember { mutableStateOf(Store.get(context).recentAlerts()) }
    LaunchedEffect(Unit) {
        while (true) {
            saved = Store.get(context).recentAlerts()
            delay(5000)
        }
    }

    Card(Modifier.fillMaxWidth()) {
        SwitchRow("Monitor in the background", monitoring) {
            monitoring = it
            settings.monitoring = it
            if (it) MonitorService.start(context) else MonitorService.stop(context)
        }
        HorizontalDivider()
        SwitchRow("Alert notifications", alerts) {
            alerts = it
            settings.alerts = it
        }
        HorizontalDivider()
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            Text("Remind me to unplug at", style = MaterialTheme.typography.bodyLarge)
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf(0, 80, 85, 90).forEach { level ->
                    FilterChip(
                        selected = unplugAt == level,
                        onClick = { unplugAt = level; settings.unplugAt = level },
                        label = { Text(if (level == 0) "Never" else "$level%") },
                    )
                }
            }
        }
        HorizontalDivider()
        Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Try one", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
            OutlinedButton(onClick = {
                Alerts.notify(context, 99, "Battery Speed notifications work", "Alerts look like this. Tap one to open Battery Speed.")
            }) { Text("Send test") }
        }
    }
    Footnote(
        "Background monitoring keeps a quiet notification with the live status, like the menu bar readout on a Mac. " +
            "It is needed for alerts: Android stops apps that run in the background without one.",
    )

    SectionTitle("Recent")
    if (saved.isEmpty()) {
        Footnote("No alerts yet. You'll be told when the battery runs low, when a charger can't keep up, and when it is time to unplug.")
    } else {
        Card(Modifier.fillMaxWidth()) {
            saved.forEachIndexed { i, a ->
                if (i > 0) HorizontalDivider()
                Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
                    Icon(
                        painterResource(if (a.severity == "good") R.drawable.ic_check else R.drawable.ic_warning),
                        contentDescription = null,
                        tint = when (a.severity) { "good" -> Good; "critical" -> Bad; else -> Warn },
                        modifier = Modifier.size(18.dp).padding(top = 2.dp),
                    )
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(a.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                        Text(a.body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(
                        DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(a.ts)),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

// ---------------------------------------------------------------- building blocks

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp, start = 4.dp))
}

@Composable
private fun Rows(vararg rows: Pair<String, String>) {
    Card(Modifier.fillMaxWidth()) {
        rows.forEachIndexed { i, (label, value) ->
            if (i > 0) HorizontalDivider()
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                Text(value, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun Footnote(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 4.dp),
    )
}
