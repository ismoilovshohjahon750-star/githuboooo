package com.example.server

import android.content.Context
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Collections
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class EmbeddedWebServer(
    private val context: Context,
    val port: Int = DEFAULT_PORT
) {
    private val tag = "EmbeddedWebServer"

    private val dbFile = File(context.filesDir, "smartboard_web_db.json")
    private val dbLock = Any()
    private val random = SecureRandom()

    @Volatile
    private var isRunning = false
    private var serverSocket: ServerSocket? = null
    private var udpDiscoverySocket: DatagramSocket? = null
    private var acceptThread: Thread? = null
    private var udpThread: Thread? = null
    private var workerPool: ExecutorService? = null

    private val connectedBoards = ConcurrentHashMap<String, BoardRecord>()
    private val boardQueues = ConcurrentHashMap<String, MutableList<JSONObject>>()
    private val newlyDetectedHistory = ConcurrentHashMap<String, String>()

    private var db: JSONObject = loadDatabase()

    data class BoardRecord(
        val mac: String,
        val boardId: String,
        val hardwareId: String,
        val roomId: String,
        val roomName: String,
        val isLocked: Boolean,
        val secondsRemaining: Int,
        val teacherName: String,
        val appVersion: String,
        val lastSeen: Long,
        val ip: String,
        val isRegistered: Boolean
    ) {
        fun toJson(boardKey: String, nowMs: Long): JSONObject {
            val isOnline = (nowMs - lastSeen) < 15000L
            return JSONObject().apply {
                put("boardKey", boardKey)
                put("mac", mac)
                put("boardId", boardId)
                put("hardwareId", hardwareId)
                put("roomId", roomId)
                put("roomName", roomName)
                put("isLocked", isLocked)
                put("secondsRemaining", secondsRemaining)
                put("teacherName", teacherName)
                put("appVersion", appVersion)
                put("lastSeen", lastSeen)
                put("ip", ip)
                put("isRegistered", isRegistered)
                put("isOnline", isOnline)
            }
        }
    }

    data class AuthUser(
        val id: Long,
        val username: String,
        val name: String,
        val role: String
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("id", id)
            put("username", username)
            put("name", name)
            put("role", role)
        }
    }

    fun start(): Boolean {
        synchronized(this) {
            if (isRunning) return true
            return try {
                val ss = ServerSocket().apply {
                    reuseAddress = true
                    bind(InetSocketAddress("0.0.0.0", port))
                }
                serverSocket = ss
                workerPool = Executors.newCachedThreadPool()
                isRunning = true

                acceptThread = Thread({
                    Log.i(tag, "HTTP veb-server 0.0.0.0:$port portida ishga tushdi")
                    while (isRunning) {
                        try {
                            val client = ss.accept()
                            workerPool?.execute { handleClientSocket(client) }
                        } catch (e: Exception) {
                            if (isRunning) {
                                Log.w(tag, "Accept xatosi: ${e.message}")
                            }
                        }
                    }
                }, "SmartBoard-WebHttpAccept").apply { isDaemon = true; start() }

                startUdpResponder()
                true
            } catch (e: Exception) {
                Log.e(tag, "Veb-serverni ishga tushirishda xatolik: ${e.message}", e)
                stop()
                false
            }
        }
    }

    fun stop() {
        synchronized(this) {
            isRunning = false
            try { serverSocket?.close() } catch (_: Exception) {}
            serverSocket = null
            try { udpDiscoverySocket?.close() } catch (_: Exception) {}
            udpDiscoverySocket = null
            try { workerPool?.shutdownNow() } catch (_: Exception) {}
            workerPool = null
            acceptThread = null
            udpThread = null
        }
    }

    fun isServerRunning(): Boolean = isRunning

    private fun startUdpResponder() {
        udpThread = Thread({
            try {
                val ds = DatagramSocket(null).apply {
                    reuseAddress = true
                    broadcast = true
                    bind(InetSocketAddress(DISCOVERY_UDP_PORT))
                }
                udpDiscoverySocket = ds
                val buf = ByteArray(1024)
                while (isRunning && !ds.isClosed) {
                    try {
                        val packet = DatagramPacket(buf, buf.size)
                        ds.receive(packet)
                        val msg = String(packet.data, 0, packet.length, Charsets.UTF_8).trim()
                        if (msg == DISCOVERY_REQUEST_MSG && !packet.address.isLoopbackAddress) {
                            val bestUrl = getLocalWifiUrls(port).firstOrNull()
                            if (bestUrl != null) {
                                val reply = "$DISCOVERY_RESPONSE_PREFIX$bestUrl".toByteArray(Charsets.UTF_8)
                                val replyPacket = DatagramPacket(reply, reply.size, packet.address, packet.port)
                                ds.send(replyPacket)
                            }
                        }
                    } catch (_: Exception) {
                        if (!isRunning) break
                    }
                }
            } catch (e: Exception) {
                Log.w(tag, "UDP responder to'xtadi: ${e.message}")
            }
        }, "SmartBoard-UdpResponder").apply { isDaemon = true; start() }
    }

    private fun handleClientSocket(socket: Socket) {
        try {
            socket.soTimeout = 15000
            val input = BufferedInputStream(socket.getInputStream())
            val output = socket.getOutputStream()

            val headerBytes = readUntilHeaderEnd(input) ?: return
            val headerText = headerBytes.toString(Charsets.ISO_8859_1)
            val lines = headerText.split("\r\n")
            if (lines.isEmpty()) return

            val requestLineParts = lines[0].trim().split(" ")
            if (requestLineParts.size < 2) return

            val method = requestLineParts[0].uppercase(Locale.US)
            val rawTarget = requestLineParts[1]
            val qIdx = rawTarget.indexOf('?')
            val rawPath = if (qIdx >= 0) rawTarget.substring(0, qIdx) else rawTarget
            val pathname = if (rawPath.length > 1 && rawPath.endsWith("/")) {
                rawPath.dropLast(1)
            } else {
                rawPath
            }

            val headers = HashMap<String, String>()
            for (i in 1 until lines.size) {
                val line = lines[i]
                val colon = line.indexOf(':')
                if (colon > 0) {
                    val key = line.substring(0, colon).trim().lowercase(Locale.US)
                    val value = line.substring(colon + 1).trim()
                    headers[key] = value
                }
            }

            val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
            val bodyBytes = if (contentLength in 1..2_097_152) {
                readExactBytes(input, contentLength)
            } else {
                ByteArray(0)
            }

            val clientIp = (headers["x-forwarded-for"]
                ?.split(",")
                ?.firstOrNull()
                ?.trim()
                ?.takeIf { it.isNotBlank() })
                ?: socket.inetAddress?.hostAddress
                ?: ""

            routeRequest(method, pathname, headers, bodyBytes, clientIp, output)
        } catch (e: SocketTimeoutException) {
            // Normal keepalive/timeout
        } catch (e: Exception) {
            Log.w(tag, "HTTP so'rovini qayta ishlashda xato: ${e.message}")
            try {
                sendJson(
                    socket.getOutputStream(),
                    500,
                    JSONObject().put("error", "Ichki server xatoligi")
                )
            } catch (_: Exception) {}
        } finally {
            try { socket.close() } catch (_: Exception) {}
        }
    }

    private fun readUntilHeaderEnd(input: InputStream): ByteArray? {
        val baos = ByteArrayOutputStream()
        var matched = 0
        while (baos.size() < 32_768) {
            val b = input.read()
            if (b == -1) {
                return if (baos.size() == 0) null else baos.toByteArray()
            }
            baos.write(b)
            matched = when {
                (matched == 0 || matched == 2) && b == 13 -> matched + 1
                (matched == 1 || matched == 3) && b == 10 -> matched + 1
                b == 13 -> 1
                else -> 0
            }
            if (matched == 4) {
                return baos.toByteArray()
            }
        }
        return null
    }

    private fun readExactBytes(input: InputStream, length: Int): ByteArray {
        val result = ByteArray(length)
        var offset = 0
        while (offset < length) {
            val read = input.read(result, offset, length - offset)
            if (read == -1) break
            offset += read
        }
        return if (offset == length) result else result.copyOf(offset)
    }

    private fun routeRequest(
        method: String,
        pathname: String,
        headers: Map<String, String>,
        bodyBytes: ByteArray,
        clientIp: String,
        out: OutputStream
    ) {
        if (method == "OPTIONS") {
            sendEmpty(out, 204)
            return
        }

        val bodyJson: JSONObject = if (method == "POST" || method == "PUT" || method == "PATCH") {
            val raw = bodyBytes.toString(Charsets.UTF_8).trim()
            if (raw.isBlank()) {
                JSONObject()
            } else {
                try {
                    JSONObject(raw)
                } catch (_: Exception) {
                    sendJson(out, 400, JSONObject().put("error", "Noto'g'ri JSON formati"))
                    return
                }
            }
        } else {
            JSONObject()
        }

        // Static website routes
        if ((method == "GET" || method == "HEAD") &&
            (pathname == "/" || pathname == "/webapp" || pathname == "/index.html")
        ) {
            val htmlBytes = loadWebAsset("webapp/index.html")
            if (htmlBytes != null) {
                sendBytes(out, 200, htmlBytes, "text/html; charset=utf-8", method == "HEAD")
            } else {
                sendText(out, 404, "index.html topilmadi")
            }
            return
        }

        if (method == "GET" && pathname == "/health") {
            sendText(out, 200, "OK")
            return
        }

        if (method == "GET" && pathname == "/api/status") {
            val payload = synchronized(dbLock) {
                val lanArr = JSONArray()
                getLocalWifiUrls(port).forEach { lanArr.put(it) }
                JSONObject().apply {
                    put("status", "online")
                    put("service", "SmartBoard 86 Embedded Web Server")
                    put("time", getFormattedTime())
                    put("port", port)
                    put("lanUrls", lanArr)
                    put("activeBoardsCount", connectedBoards.size)
                    put("roomsCount", db.optJSONArray("rooms")?.length() ?: 0)
                }
            }
            sendJson(out, 200, payload)
            return
        }

        // Auth routes
        if (method == "POST" && pathname == "/api/auth/login") {
            val username = bodyJson.optString("username", "").trim()
            val password = bodyJson.optString("password", "")
            if (username.isBlank() || password.isEmpty()) {
                sendJson(out, 400, JSONObject().put("error", "Login va parolni kiriting"))
                return
            }

            val loginResult = synchronized(dbLock) {
                val userRecord = findUserByLogin(username)
                val storedHash = userRecord?.first?.optString("passwordHash", "") ?: ""
                if (userRecord == null || !verifyPassword(password, storedHash)) {
                    null
                } else {
                    val obj = userRecord.first
                    val role = userRecord.second
                    val safeUser = AuthUser(
                        id = obj.optLong("id", 0L),
                        username = obj.optString("username", ""),
                        name = obj.optString("name", ""),
                        role = role
                    )
                    val token = createSessionToken(safeUser)
                    logAccessLocked(safeUser.id, safeUser.name, safeUser.role, "Veb-saytga kirdi")
                    JSONObject().apply {
                        put("token", token)
                        put("user", safeUser.toJson())
                    }
                }
            }

            if (loginResult == null) {
                sendJson(out, 401, JSONObject().put("error", "Login yoki parol noto'g'ri"))
            } else {
                sendJson(out, 200, loginResult)
            }
            return
        }

        if (method == "GET" && pathname == "/api/auth/me") {
            val authUser = getAuthenticatedUser(headers, out) ?: return
            sendJson(out, 200, JSONObject().put("user", authUser.toJson()))
            return
        }

        if (method == "POST" && pathname == "/api/auth/change-password") {
            val authUser = getAuthenticatedUser(headers, out) ?: return
            val currentPassword = bodyJson.optString("currentPassword", "")
            val newPassword = bodyJson.optString("newPassword", "")
            if (currentPassword.isEmpty() || newPassword.length < 4) {
                sendJson(out, 400, JSONObject().put("error", "Joriy parol va kamida 4 belgili yangi parolni kiriting"))
                return
            }

            val updated = synchronized(dbLock) {
                val target = findRecordByRoleAndIdLocked(authUser.role, authUser.id)
                if (target == null || !verifyPassword(currentPassword, target.optString("passwordHash", ""))) {
                    false
                } else {
                    target.put("passwordHash", hashPassword(newPassword))
                    saveDatabaseLocked()
                    logAccessLocked(authUser.id, authUser.name, authUser.role, "Parol yangilandi")
                    true
                }
            }
            if (!updated) {
                sendJson(out, 400, JSONObject().put("error", "Joriy parol noto'g'ri"))
            } else {
                sendJson(out, 200, JSONObject().put("status", "ok"))
            }
            return
        }

        // Dashboard state
        if (method == "GET" && pathname == "/api/state") {
            val authUser = getAuthenticatedUser(headers, out) ?: return
            val payload = synchronized(dbLock) {
                val now = System.currentTimeMillis()
                val roomsArr = db.optJSONArray("rooms") ?: JSONArray()
                val boardsArr = JSONArray()
                val unassignedArr = JSONArray()

                for ((key, b) in connectedBoards.entries) {
                    val item = b.toJson(key, now)
                    boardsArr.put(item)
                    var isReg = false
                    for (i in 0 until roomsArr.length()) {
                        val r = roomsArr.optJSONObject(i) ?: continue
                        if (r.optString("id", "").equals(key, ignoreCase = true)) {
                            isReg = true
                            break
                        }
                    }
                    if (!isReg) {
                        val unassignedItem = JSONObject(item.toString())
                        unassignedItem.put("detectedAt", newlyDetectedHistory[key] ?: getFormattedTime())
                        unassignedArr.put(unassignedItem)
                    }
                }

                val isAdmin = authUser.role == "SUPER_ADMIN" || authUser.role == "IT_ADMIN"
                val isSuperAdmin = authUser.role == "SUPER_ADMIN"

                val lanUrlsArr = JSONArray()
                getLocalWifiUrls(port).forEach { lanUrlsArr.put(it) }

                val teachersOut = JSONArray()
                if (isAdmin) {
                    val tArr = db.optJSONArray("teachers") ?: JSONArray()
                    for (i in 0 until tArr.length()) {
                        val t = tArr.optJSONObject(i) ?: continue
                        teachersOut.put(JSONObject().apply {
                            put("id", t.optLong("id", 0L))
                            put("username", t.optString("username", ""))
                            put("name", t.optString("name", ""))
                            put("addedAt", t.optString("addedAt", ""))
                        })
                    }
                }

                val itAdminsOut = JSONArray()
                if (isSuperAdmin) {
                    val aArr = db.optJSONArray("itAdmins") ?: JSONArray()
                    for (i in 0 until aArr.length()) {
                        val a = aArr.optJSONObject(i) ?: continue
                        itAdminsOut.put(JSONObject().apply {
                            put("id", a.optLong("id", 0L))
                            put("username", a.optString("username", ""))
                            put("name", a.optString("name", ""))
                            put("addedAt", a.optString("addedAt", ""))
                        })
                    }
                }

                val logsOut = JSONArray()
                if (isAdmin) {
                    val lArr = db.optJSONArray("logs") ?: JSONArray()
                    val limit = minOf(lArr.length(), 100)
                    for (i in 0 until limit) {
                        logsOut.put(lArr.optJSONObject(i))
                    }
                }

                JSONObject().apply {
                    put("user", authUser.toJson())
                    put("serverTime", getFormattedTime())
                    put("lanUrls", lanUrlsArr)
                    put("rooms", roomsArr)
                    put("boards", boardsArr)
                    put("unassignedBoards", if (isAdmin) unassignedArr else JSONArray())
                    put("teachers", teachersOut)
                    put("itAdmins", itAdminsOut)
                    put("logs", logsOut)
                }
            }
            sendJson(out, 200, payload)
            return
        }

        // Board action
        if (method == "POST" && pathname == "/api/boards/action") {
            val authUser = getAuthenticatedUser(headers, out) ?: return
            val action = bodyJson.optString("action", "").trim().lowercase(Locale.US)
            val target = bodyJson.optString("targetRoomId", "").trim().uppercase(Locale.US)
            if (target.isBlank() || target == "ALL") {
                sendJson(out, 400, JSONObject().put("error", "Iltimos, aniq bitta doskani tanlang"))
                return
            }

            val roomTitle = synchronized(dbLock) { findRoomNameLocked(target) ?: target }

            when (action) {
                "unlock" -> {
                    val mins = bodyJson.optInt("durationMinutes", 45).coerceIn(5, 180)
                    val cmd = JSONObject().apply {
                        put("type", "UNLOCK")
                        put("teacherName", authUser.name)
                        put("durationMinutes", mins)
                        put("targetRoomId", target)
                    }
                    enqueueCommandForTarget(target, cmd)
                    synchronized(dbLock) {
                        logAccessLocked(authUser.id, authUser.name, authUser.role, "Dars boshlandi: $roomTitle ($mins daqiqa)")
                    }
                    sendJson(out, 200, JSONObject().put("status", "ok").put("durationMinutes", mins))
                }
                "lock" -> {
                    val cmd = JSONObject().apply {
                        put("type", "LOCK")
                        put("targetRoomId", target)
                    }
                    enqueueCommandForTarget(target, cmd)
                    synchronized(dbLock) {
                        logAccessLocked(authUser.id, authUser.name, authUser.role, "Doska qulflandi: $roomTitle")
                    }
                    sendJson(out, 200, JSONObject().put("status", "ok"))
                }
                "extend" -> {
                    val cmd = JSONObject().apply {
                        put("type", "EXTEND")
                        put("minutes", 10)
                        put("targetRoomId", target)
                    }
                    enqueueCommandForTarget(target, cmd)
                    synchronized(dbLock) {
                        logAccessLocked(authUser.id, authUser.name, authUser.role, "+10 daqiqa qo'shildi: $roomTitle")
                    }
                    sendJson(out, 200, JSONObject().put("status", "ok"))
                }
                else -> sendJson(out, 400, JSONObject().put("error", "Noto'g'ri amal"))
            }
            return
        }

        // Rooms CRUD
        if (pathname == "/api/rooms") {
            val authUser = getAuthenticatedUser(headers, out) ?: return
            if (!requireAdminUser(authUser, out)) return

            if (method == "POST") {
                val roomId = bodyJson.optString("id", "").trim().uppercase(Locale.US)
                val roomName = bodyJson.optString("name", "").trim()
                if (roomId.length < 4 || roomName.length < 2) {
                    sendJson(out, 400, JSONObject().put("error", "Qurilma ID (kamida 4 belgi) va xona nomi (kamida 2 belgi) kiritilishi kerak"))
                    return
                }
                synchronized(dbLock) {
                    val rooms = db.optJSONArray("rooms") ?: JSONArray().also { db.put("rooms", it) }
                    var existing: JSONObject? = null
                    for (i in 0 until rooms.length()) {
                        val r = rooms.optJSONObject(i) ?: continue
                        if (r.optString("id", "").equals(roomId, ignoreCase = true)) {
                            existing = r
                            break
                        }
                    }
                    if (existing != null) {
                        existing.put("name", roomName)
                        existing.put("addedBy", authUser.name)
                        existing.put("addedAt", getFormattedTime())
                    } else {
                        rooms.put(JSONObject().apply {
                            put("id", roomId)
                            put("name", roomName)
                            put("addedBy", authUser.name)
                            put("addedAt", getFormattedTime())
                        })
                    }
                    newlyDetectedHistory.remove(roomId)
                    saveDatabaseLocked()
                    logAccessLocked(authUser.id, authUser.name, authUser.role, "Xona saqlandi: $roomName ($roomId)")
                }
                sendJson(out, 200, JSONObject().put("status", "ok"))
                return
            }

            if (method == "DELETE") {
                val count = synchronized(dbLock) {
                    val rooms = db.optJSONArray("rooms") ?: JSONArray()
                    val c = rooms.length()
                    db.put("rooms", JSONArray())
                    connectedBoards.clear()
                    boardQueues.clear()
                    newlyDetectedHistory.clear()
                    saveDatabaseLocked()
                    logAccessLocked(authUser.id, authUser.name, authUser.role, "Barcha doskalar tizimdan butunlay o'chirildi ($c ta)")
                    c
                }
                sendJson(out, 200, JSONObject().put("status", "ok").put("deletedCount", count))
                return
            }
        }

        if (pathname.startsWith("/api/rooms/")) {
            val authUser = getAuthenticatedUser(headers, out) ?: return
            if (!requireAdminUser(authUser, out)) return

            val targetId = decodeSegment(pathname.removePrefix("/api/rooms/")).trim().uppercase(Locale.US)
            if (targetId.isBlank()) {
                sendJson(out, 404, JSONObject().put("error", "Xona topilmadi"))
                return
            }

            if (method == "PUT") {
                val roomName = bodyJson.optString("name", "").trim()
                if (roomName.length < 2) {
                    sendJson(out, 400, JSONObject().put("error", "Xona nomi kamida 2 belgidan iborat bo'lishi kerak"))
                    return
                }
                val found = synchronized(dbLock) {
                    val rooms = db.optJSONArray("rooms") ?: JSONArray()
                    var targetObj: JSONObject? = null
                    for (i in 0 until rooms.length()) {
                        val r = rooms.optJSONObject(i) ?: continue
                        if (r.optString("id", "").equals(targetId, ignoreCase = true)) {
                            targetObj = r
                            break
                        }
                    }
                    if (targetObj == null) {
                        false
                    } else {
                        val oldName = targetObj.optString("name", "")
                        targetObj.put("name", roomName)
                        saveDatabaseLocked()
                        logAccessLocked(authUser.id, authUser.name, authUser.role, "Xona tahrirlandi: $oldName -> $roomName")
                        true
                    }
                }
                if (!found) {
                    sendJson(out, 404, JSONObject().put("error", "Xona topilmadi"))
                } else {
                    sendJson(out, 200, JSONObject().put("status", "ok"))
                }
                return
            }

            if (method == "DELETE") {
                val removedName = synchronized(dbLock) {
                    val rooms = db.optJSONArray("rooms") ?: JSONArray()
                    var removed: String? = null
                    val nextRooms = JSONArray()
                    for (i in 0 until rooms.length()) {
                        val r = rooms.optJSONObject(i) ?: continue
                        if (removed == null && r.optString("id", "").equals(targetId, ignoreCase = true)) {
                            removed = r.optString("name", targetId)
                        } else {
                            nextRooms.put(r)
                        }
                    }
                    if (removed != null) {
                        db.put("rooms", nextRooms)
                        boardQueues.remove(targetId)
                        newlyDetectedHistory.remove(targetId)
                        saveDatabaseLocked()
                        logAccessLocked(authUser.id, authUser.name, authUser.role, "Xona o'chirildi: $removed")
                    }
                    removed
                }
                if (removedName == null) {
                    sendJson(out, 404, JSONObject().put("error", "Xona topilmadi"))
                } else {
                    sendJson(out, 200, JSONObject().put("status", "ok"))
                }
                return
            }
        }

        // Teachers CRUD
        if (pathname == "/api/teachers" && method == "POST") {
            val authUser = getAuthenticatedUser(headers, out) ?: return
            if (!requireAdminUser(authUser, out)) return

            val name = bodyJson.optString("name", "").trim()
            val username = normalizeUsername(bodyJson.optString("username", ""), "")
            val password = bodyJson.optString("password", "").trim()

            if (name.isBlank() || username.isBlank() || password.length < 4) {
                sendJson(out, 400, JSONObject().put("error", "F.I.SH, login va kamida 4 belgili parol kiritilishi kerak"))
                return
            }

            val errMsg = synchronized(dbLock) {
                if (isUsernameTakenLocked(username)) {
                    "Ushbu login allaqachon band"
                } else {
                    val arr = db.optJSONArray("teachers") ?: JSONArray().also { db.put("teachers", it) }
                    arr.put(JSONObject().apply {
                        put("id", generateNumericId())
                        put("username", username)
                        put("name", name)
                        put("passwordHash", hashPassword(password))
                        put("addedAt", getFormattedTime())
                    })
                    saveDatabaseLocked()
                    logAccessLocked(authUser.id, authUser.name, authUser.role, "O'qituvchi qo'shildi: $name (@$username)")
                    null
                }
            }
            if (errMsg != null) {
                sendJson(out, 400, JSONObject().put("error", errMsg))
            } else {
                sendJson(out, 200, JSONObject().put("status", "ok"))
            }
            return
        }

        if (pathname.startsWith("/api/teachers/")) {
            val authUser = getAuthenticatedUser(headers, out) ?: return
            if (!requireAdminUser(authUser, out)) return
            val targetId = decodeSegment(pathname.removePrefix("/api/teachers/")).toLongOrNull()
            if (targetId == null) {
                sendJson(out, 404, JSONObject().put("error", "O'qituvchi topilmadi"))
                return
            }

            if (method == "PUT") {
                val resPair = synchronized(dbLock) {
                    val arr = db.optJSONArray("teachers") ?: JSONArray()
                    var teacher: JSONObject? = null
                    for (i in 0 until arr.length()) {
                        val t = arr.optJSONObject(i) ?: continue
                        if (t.optLong("id", -1L) == targetId) {
                            teacher = t
                            break
                        }
                    }
                    if (teacher == null) {
                        404 to "O'qituvchi topilmadi"
                    } else {
                        val name = bodyJson.optString("name", "").trim().ifBlank { teacher.optString("name", "") }
                        val rawUser = bodyJson.optString("username", "").trim()
                        val username = if (rawUser.isNotBlank()) normalizeUsername(rawUser, teacher.optString("username", "")) else teacher.optString("username", "")
                        val password = bodyJson.optString("password", "").trim()
                        when {
                            name.isBlank() || username.isBlank() -> 400 to "F.I.SH va login bo'sh bo'lmasligi kerak"
                            isUsernameTakenLocked(username, "TEACHER", targetId) -> 400 to "Ushbu login allaqachon band"
                            password.isNotEmpty() && password.length < 4 -> 400 to "Yangi parol kamida 4 belgidan iborat bo'lishi kerak"
                            else -> {
                                teacher.put("name", name)
                                teacher.put("username", username)
                                if (password.isNotEmpty()) {
                                    teacher.put("passwordHash", hashPassword(password))
                                }
                                saveDatabaseLocked()
                                logAccessLocked(authUser.id, authUser.name, authUser.role, "O'qituvchi yangilandi: $name")
                                200 to "ok"
                            }
                        }
                    }
                }
                if (resPair.first == 200) {
                    sendJson(out, 200, JSONObject().put("status", "ok"))
                } else {
                    sendJson(out, resPair.first, JSONObject().put("error", resPair.second))
                }
                return
            }

            if (method == "DELETE") {
                val removedName = synchronized(dbLock) {
                    val arr = db.optJSONArray("teachers") ?: JSONArray()
                    var removed: String? = null
                    val next = JSONArray()
                    for (i in 0 until arr.length()) {
                        val t = arr.optJSONObject(i) ?: continue
                        if (removed == null && t.optLong("id", -1L) == targetId) {
                            removed = t.optString("name", "")
                        } else {
                            next.put(t)
                        }
                    }
                    if (removed != null) {
                        db.put("teachers", next)
                        saveDatabaseLocked()
                        logAccessLocked(authUser.id, authUser.name, authUser.role, "O'qituvchi o'chirildi: $removed")
                    }
                    removed
                }
                if (removedName == null) {
                    sendJson(out, 404, JSONObject().put("error", "O'qituvchi topilmadi"))
                } else {
                    sendJson(out, 200, JSONObject().put("status", "ok"))
                }
                return
            }
        }

        // IT Admins CRUD
        if (pathname == "/api/it-admins" && method == "POST") {
            val authUser = getAuthenticatedUser(headers, out) ?: return
            if (!requireSuperAdminUser(authUser, out)) return

            val name = bodyJson.optString("name", "").trim()
            val username = normalizeUsername(bodyJson.optString("username", ""), "")
            val password = bodyJson.optString("password", "").trim()

            if (name.isBlank() || username.isBlank() || password.length < 4) {
                sendJson(out, 400, JSONObject().put("error", "F.I.SH, login va kamida 4 belgili parol kiritilishi kerak"))
                return
            }

            val errMsg = synchronized(dbLock) {
                if (isUsernameTakenLocked(username)) {
                    "Ushbu login allaqachon band"
                } else {
                    val arr = db.optJSONArray("itAdmins") ?: JSONArray().also { db.put("itAdmins", it) }
                    arr.put(JSONObject().apply {
                        put("id", generateNumericId())
                        put("username", username)
                        put("name", name)
                        put("passwordHash", hashPassword(password))
                        put("addedAt", getFormattedTime())
                    })
                    saveDatabaseLocked()
                    logAccessLocked(authUser.id, authUser.name, authUser.role, "IT Admin qo'shildi: $name (@$username)")
                    null
                }
            }
            if (errMsg != null) {
                sendJson(out, 400, JSONObject().put("error", errMsg))
            } else {
                sendJson(out, 200, JSONObject().put("status", "ok"))
            }
            return
        }

        if (pathname.startsWith("/api/it-admins/")) {
            val authUser = getAuthenticatedUser(headers, out) ?: return
            if (!requireSuperAdminUser(authUser, out)) return
            val targetId = decodeSegment(pathname.removePrefix("/api/it-admins/")).toLongOrNull()
            if (targetId == null) {
                sendJson(out, 404, JSONObject().put("error", "IT Admin topilmadi"))
                return
            }

            if (method == "PUT") {
                val resPair = synchronized(dbLock) {
                    val arr = db.optJSONArray("itAdmins") ?: JSONArray()
                    var admin: JSONObject? = null
                    for (i in 0 until arr.length()) {
                        val a = arr.optJSONObject(i) ?: continue
                        if (a.optLong("id", -1L) == targetId) {
                            admin = a
                            break
                        }
                    }
                    if (admin == null) {
                        404 to "IT Admin topilmadi"
                    } else {
                        val name = bodyJson.optString("name", "").trim().ifBlank { admin.optString("name", "") }
                        val rawUser = bodyJson.optString("username", "").trim()
                        val username = if (rawUser.isNotBlank()) normalizeUsername(rawUser, admin.optString("username", "")) else admin.optString("username", "")
                        val password = bodyJson.optString("password", "").trim()
                        when {
                            name.isBlank() || username.isBlank() -> 400 to "F.I.SH va login bo'sh bo'lmasligi kerak"
                            isUsernameTakenLocked(username, "IT_ADMIN", targetId) -> 400 to "Ushbu login allaqachon band"
                            password.isNotEmpty() && password.length < 4 -> 400 to "Yangi parol kamida 4 belgidan iborat bo'lishi kerak"
                            else -> {
                                admin.put("name", name)
                                admin.put("username", username)
                                if (password.isNotEmpty()) {
                                    admin.put("passwordHash", hashPassword(password))
                                }
                                saveDatabaseLocked()
                                logAccessLocked(authUser.id, authUser.name, authUser.role, "IT Admin yangilandi: $name")
                                200 to "ok"
                            }
                        }
                    }
                }
                if (resPair.first == 200) {
                    sendJson(out, 200, JSONObject().put("status", "ok"))
                } else {
                    sendJson(out, resPair.first, JSONObject().put("error", resPair.second))
                }
                return
            }

            if (method == "DELETE") {
                val removedName = synchronized(dbLock) {
                    val arr = db.optJSONArray("itAdmins") ?: JSONArray()
                    var removed: String? = null
                    val next = JSONArray()
                    for (i in 0 until arr.length()) {
                        val a = arr.optJSONObject(i) ?: continue
                        if (removed == null && a.optLong("id", -1L) == targetId) {
                            removed = a.optString("name", "")
                        } else {
                            next.put(a)
                        }
                    }
                    if (removed != null) {
                        db.put("itAdmins", next)
                        saveDatabaseLocked()
                        logAccessLocked(authUser.id, authUser.name, authUser.role, "IT Admin o'chirildi: $removed")
                    }
                    removed
                }
                if (removedName == null) {
                    sendJson(out, 404, JSONObject().put("error", "IT Admin topilmadi"))
                } else {
                    sendJson(out, 200, JSONObject().put("status", "ok"))
                }
                return
            }
        }

        // Clear logs
        if (pathname == "/api/logs" && method == "DELETE") {
            val authUser = getAuthenticatedUser(headers, out) ?: return
            if (!requireSuperAdminUser(authUser, out)) return
            synchronized(dbLock) {
                db.put("logs", JSONArray())
                saveDatabaseLocked()
                logAccessLocked(authUser.id, authUser.name, authUser.role, "Jurnal tozalandi")
            }
            sendJson(out, 200, JSONObject().put("status", "ok"))
            return
        }

        // Board APK endpoints
        if (method == "GET" && pathname == "/api/board/list") {
            val payload = synchronized(dbLock) {
                val now = System.currentTimeMillis()
                val arr = JSONArray()
                for ((key, b) in connectedBoards.entries) {
                    arr.put(b.toJson(key, now))
                }
                JSONObject().apply {
                    put("boards", arr)
                    put("rooms", db.optJSONArray("rooms") ?: JSONArray())
                }
            }
            sendJson(out, 200, payload)
            return
        }

        if (method == "POST" && pathname == "/api/board/poll") {
            val clientMac = bodyJson.optString("mac", "").trim().uppercase(Locale.US)
            val clientBoardId = bodyJson.optString("boardId", "").trim().uppercase(Locale.US)
            val clientHwId = bodyJson.optString("hardwareId", "").trim().uppercase(Locale.US)
            val roomName = bodyJson.optString("roomName", "").trim()

            if (clientMac.isBlank() && clientBoardId.isBlank() && clientHwId.isBlank()) {
                sendJson(out, 400, JSONObject().put("error", "Qurilma identifikatori talab qilinadi"))
                return
            }

            val boardKey = resolveBoardKey(clientMac, clientBoardId, clientHwId, clientIp)

            val matchedRoom: JSONObject? = synchronized(dbLock) {
                val rooms = db.optJSONArray("rooms") ?: JSONArray()
                val macNoColon = clientMac.replace(":", "")
                var found: JSONObject? = null
                for (i in 0 until rooms.length()) {
                    val r = rooms.optJSONObject(i) ?: continue
                    val rId = r.optString("id", "").trim().uppercase(Locale.US)
                    val rIdNoColon = rId.replace(":", "")
                    val rName = r.optString("name", "").trim()
                    if (rId == boardKey ||
                        (clientMac.isNotBlank() && rId == clientMac) ||
                        (clientBoardId.isNotBlank() && rId == clientBoardId) ||
                        (clientHwId.isNotBlank() && rId == clientHwId) ||
                        (macNoColon.isNotBlank() && rIdNoColon == macNoColon) ||
                        (rName.isNotBlank() && roomName.isNotBlank() && rName.equals(roomName, ignoreCase = true))
                    ) {
                        found = JSONObject(r.toString())
                        break
                    }
                }
                found
            }

            val regId = matchedRoom?.optString("id", "")
            val regName = matchedRoom?.optString("name", "")
            val isReg = matchedRoom != null

            connectedBoards[boardKey] = BoardRecord(
                mac = clientMac.ifBlank { "N/A" },
                boardId = clientBoardId.ifBlank { "N/A" },
                hardwareId = clientHwId.ifBlank { "N/A" },
                roomId = if (!regId.isNullOrBlank()) regId else boardKey,
                roomName = if (!regName.isNullOrBlank()) regName else roomName.ifBlank { "Noma'lum xona" },
                isLocked = bodyJson.optBoolean("isLocked", false),
                secondsRemaining = bodyJson.optInt("secondsRemaining", 0),
                teacherName = bodyJson.optString("teacherName", ""),
                appVersion = bodyJson.optString("appVersion", "1.0"),
                lastSeen = System.currentTimeMillis(),
                ip = clientIp,
                isRegistered = isReg
            )

            if (!isReg && !newlyDetectedHistory.containsKey(boardKey)) {
                newlyDetectedHistory[boardKey] = getFormattedTime()
            }

            val possibleKeys = mutableListOf(boardKey)
            if (clientMac.isNotBlank()) possibleKeys.add(clientMac)
            if (clientBoardId.isNotBlank()) possibleKeys.add(clientBoardId)
            if (!regId.isNullOrBlank()) possibleKeys.add(regId.uppercase(Locale.US))

            var targetCmd: JSONObject? = null
            for (k in possibleKeys) {
                val queue = boardQueues[k]
                if (queue != null) {
                    synchronized(queue) {
                        if (queue.isNotEmpty()) {
                            targetCmd = queue.removeAt(0)
                        }
                        if (queue.isEmpty()) {
                            boardQueues.remove(k)
                        }
                    }
                    if (targetCmd != null) break
                }
            }

            val responseJson = JSONObject().apply {
                put("status", "ok")
                put("serverTime", getFormattedTime())
                put("isRegistered", isReg)
                put("registeredRoomName", if (!regName.isNullOrBlank()) regName else JSONObject.NULL)
                put("command", targetCmd ?: JSONObject.NULL)
            }
            sendJson(out, 200, responseJson)
            return
        }

        if (method == "POST" && pathname == "/api/board/ack") {
            sendJson(out, 200, JSONObject().put("status", "acknowledged").put("commandId", bodyJson.opt("commandId") ?: JSONObject.NULL))
            return
        }

        if (method == "POST" && pathname == "/api/board/unlock") {
            val target = bodyJson.optString("targetRoomId", "").trim().uppercase(Locale.US)
            if (target.isBlank() || target == "ALL") {
                sendJson(out, 400, JSONObject().put("error", "Aniq targetRoomId ko'rsatilishi shart"))
                return
            }
            val duration = bodyJson.optInt("durationMinutes", 45).coerceIn(5, 180)
            val teacher = bodyJson.optString("teacherName", "").ifBlank { "Mas'ul O'qituvchi" }
            enqueueCommandForTarget(target, JSONObject().apply {
                put("type", "UNLOCK")
                put("teacherName", teacher)
                put("durationMinutes", duration)
                put("targetRoomId", target)
            })
            synchronized(dbLock) {
                logAccessLocked(0L, teacher, "API", "Doska ochildi: $target ($duration daqiqa)")
            }
            sendJson(out, 200, JSONObject().put("status", "enqueued").put("targetRoomId", target).put("durationMinutes", duration))
            return
        }

        if (method == "POST" && pathname == "/api/board/lock") {
            val target = bodyJson.optString("targetRoomId", "").trim().uppercase(Locale.US)
            if (target.isBlank() || target == "ALL") {
                sendJson(out, 400, JSONObject().put("error", "Aniq targetRoomId ko'rsatilishi shart"))
                return
            }
            enqueueCommandForTarget(target, JSONObject().apply {
                put("type", "LOCK")
                put("targetRoomId", target)
                put("reason", bodyJson.optString("reason", "Admin tomonidan qulflandi"))
            })
            synchronized(dbLock) {
                logAccessLocked(0L, "Admin", "API", "Doska qulflandi: $target")
            }
            sendJson(out, 200, JSONObject().put("status", "enqueued").put("targetRoomId", target))
            return
        }

        sendJson(out, 404, JSONObject().put("error", "Manzil topilmadi"))
    }

    private fun resolveBoardKey(mac: String, boardId: String, hardwareId: String, ip: String): String {
        val cleanMac = mac.trim().uppercase(Locale.US)
        val cleanBoardId = boardId.trim().uppercase(Locale.US)
        val cleanHwId = hardwareId.trim().uppercase(Locale.US)

        if (cleanMac.isNotBlank() && cleanMac != "UNKNOWN" && cleanMac.length >= 10 && cleanMac != "02:00:00:00:00:00") {
            return cleanMac
        }
        if (cleanBoardId.startsWith("BOARD_")) return cleanBoardId
        if (cleanHwId.isNotBlank() && cleanHwId != "UNKNOWN") return cleanHwId
        val sanitizedIp = ip.ifBlank { "LOCAL" }.replace(Regex("[^a-zA-Z0-9]"), "_")
        return cleanBoardId.ifBlank { cleanHwId.ifBlank { "BOARD_IP_$sanitizedIp" } }
    }

    private fun enqueueCommandForTarget(target: String, baseCommand: JSONObject) {
        val cleanTarget = target.trim().uppercase(Locale.US)
        if (cleanTarget.isBlank() || cleanTarget == "ALL") return

        val cmdId = "cmd_${System.currentTimeMillis()}_${random.nextInt(100000)}"
        val cmd = JSONObject(baseCommand.toString()).apply {
            put("id", cmdId)
            put("timestamp", System.currentTimeMillis())
            put("targetRoomId", cleanTarget)
        }

        val matchedKeys = LinkedHashSet<String>()
        matchedKeys.add(cleanTarget)

        val matchedRooms = synchronized(dbLock) {
            val rooms = db.optJSONArray("rooms") ?: JSONArray()
            val list = mutableListOf<Pair<String, String>>()
            val cleanNoColon = cleanTarget.replace(":", "")
            for (i in 0 until rooms.length()) {
                val r = rooms.optJSONObject(i) ?: continue
                val rId = r.optString("id", "").trim().uppercase(Locale.US)
                val rName = r.optString("name", "").trim().uppercase(Locale.US)
                if (rId == cleanTarget || rName == cleanTarget || rId.replace(":", "") == cleanNoColon) {
                    list.add(rId to rName)
                    matchedKeys.add(rId)
                }
            }
            list
        }

        val cleanNoColon = cleanTarget.replace(":", "")
        for ((key, b) in connectedBoards.entries) {
            val bKey = key.uppercase(Locale.US)
            val bMac = b.mac.uppercase(Locale.US)
            val bBoardId = b.boardId.uppercase(Locale.US)
            val bRoomName = b.roomName.trim().uppercase(Locale.US)
            val matches = bKey == cleanTarget ||
                bMac == cleanTarget ||
                bBoardId == cleanTarget ||
                (bRoomName.isNotBlank() && bRoomName == cleanTarget) ||
                (bMac.isNotBlank() && bMac.replace(":", "") == cleanNoColon) ||
                matchedRooms.any { (rId, rName) -> rId == bKey || (bRoomName.isNotBlank() && rName == bRoomName) }
            if (matches) {
                matchedKeys.add(bKey)
            }
        }

        for (k in matchedKeys) {
            val queue = boardQueues.getOrPut(k) { Collections.synchronizedList(mutableListOf()) }
            synchronized(queue) {
                queue.add(JSONObject(cmd.toString()).put("targetKey", k))
            }
        }
    }

    private fun loadWebAsset(assetPath: String): ByteArray? {
        return try {
            context.assets.open(assetPath).use { it.readBytes() }
        } catch (e: Exception) {
            Log.e(tag, "Asset o'qishda xatolik ($assetPath): ${e.message}")
            null
        }
    }

    private fun loadDatabase(): JSONObject {
        val secretBytes = ByteArray(32).also { random.nextBytes(it) }
        val defaultSecret = secretBytes.joinToString("") { "%02x".format(it) }

        val defaultItAdmins = JSONArray().apply {
            put(JSONObject().apply {
                put("id", 8223415949L)
                put("username", "husniddin")
                put("name", "Husniddin")
                put("passwordHash", hashPassword("admin1234"))
                put("addedAt", getFormattedTime())
            })
        }

        val defaultDb = JSONObject().apply {
            put("sessionSecret", defaultSecret)
            put("superAdmin", JSONObject().apply {
                put("id", 1L)
                put("username", "admin")
                put("name", "Bosh Admin")
                put("passwordHash", hashPassword("admin1234"))
            })
            put("itAdmins", defaultItAdmins)
            put("teachers", JSONArray())
            put("rooms", JSONArray())
            put("logs", JSONArray())
        }

        if (dbFile.exists()) {
            try {
                val parsed = JSONObject(dbFile.readText(Charsets.UTF_8))
                var migrated = false

                if (!parsed.has("sessionSecret") || parsed.optString("sessionSecret").isBlank()) {
                    parsed.put("sessionSecret", defaultSecret)
                    migrated = true
                }
                if (!parsed.has("superAdmin") || parsed.optJSONObject("superAdmin")?.optString("passwordHash").isNullOrBlank()) {
                    parsed.put("superAdmin", defaultDb.getJSONObject("superAdmin"))
                    migrated = true
                }
                if (!parsed.has("itAdmins")) {
                    parsed.put("itAdmins", defaultItAdmins)
                    migrated = true
                }
                if (!parsed.has("teachers")) parsed.put("teachers", JSONArray())
                if (!parsed.has("rooms")) parsed.put("rooms", JSONArray())
                if (!parsed.has("logs")) parsed.put("logs", JSONArray())

                if (migrated) {
                    dbFile.writeText(parsed.toString(2), Charsets.UTF_8)
                }
                return parsed
            } catch (e: Exception) {
                Log.w(tag, "Baza faylini o'qishda xatolik, yangi yaratiladi: ${e.message}")
            }
        }

        try {
            dbFile.writeText(defaultDb.toString(2), Charsets.UTF_8)
        } catch (_: Exception) {}
        return defaultDb
    }

    private fun saveDatabaseLocked() {
        try {
            dbFile.writeText(db.toString(2), Charsets.UTF_8)
        } catch (e: Exception) {
            Log.e(tag, "Bazani saqlashda xatolik: ${e.message}")
        }
    }

    private fun logAccessLocked(userId: Long, userName: String, role: String, action: String) {
        val logs = db.optJSONArray("logs") ?: JSONArray().also { db.put("logs", it) }
        val entry = JSONObject().apply {
            put("timestamp", getFormattedTime())
            put("userId", userId)
            put("userName", userName.ifBlank { "Noma'lum" })
            put("role", role.ifBlank { "Foydalanuvchi" })
            put("action", action)
        }
        val next = JSONArray()
        next.put(entry)
        val limit = minOf(logs.length(), 499)
        for (i in 0 until limit) {
            next.put(logs.optJSONObject(i))
        }
        db.put("logs", next)
        saveDatabaseLocked()
    }

    private fun findRoomNameLocked(target: String): String? {
        val rooms = db.optJSONArray("rooms") ?: return null
        for (i in 0 until rooms.length()) {
            val r = rooms.optJSONObject(i) ?: continue
            if (r.optString("id", "").equals(target, ignoreCase = true)) {
                return r.optString("name", target)
            }
        }
        return null
    }

    private fun findUserByLogin(loginInput: String): Pair<JSONObject, String>? {
        val clean = loginInput.trim().lowercase(Locale.US)
        if (clean.isBlank()) return null

        val superAdmin = db.optJSONObject("superAdmin")
        if (superAdmin != null && superAdmin.optString("username", "").lowercase(Locale.US) == clean) {
            return superAdmin to "SUPER_ADMIN"
        }

        val itAdmins = db.optJSONArray("itAdmins") ?: JSONArray()
        for (i in 0 until itAdmins.length()) {
            val a = itAdmins.optJSONObject(i) ?: continue
            if (a.optString("username", "").lowercase(Locale.US) == clean || a.optLong("id", -1L).toString() == clean) {
                return a to "IT_ADMIN"
            }
        }

        val teachers = db.optJSONArray("teachers") ?: JSONArray()
        for (i in 0 until teachers.length()) {
            val t = teachers.optJSONObject(i) ?: continue
            if (t.optString("username", "").lowercase(Locale.US) == clean || t.optLong("id", -1L).toString() == clean) {
                return t to "TEACHER"
            }
        }
        return null
    }

    private fun findRecordByRoleAndIdLocked(role: String, id: Long): JSONObject? {
        return when (role) {
            "SUPER_ADMIN" -> {
                val s = db.optJSONObject("superAdmin")
                if (s != null && s.optLong("id", -1L) == id) s else null
            }
            "IT_ADMIN" -> {
                val arr = db.optJSONArray("itAdmins") ?: return null
                (0 until arr.length()).asSequence()
                    .mapNotNull { arr.optJSONObject(it) }
                    .firstOrNull { it.optLong("id", -1L) == id }
            }
            "TEACHER" -> {
                val arr = db.optJSONArray("teachers") ?: return null
                (0 until arr.length()).asSequence()
                    .mapNotNull { arr.optJSONObject(it) }
                    .firstOrNull { it.optLong("id", -1L) == id }
            }
            else -> null
        }
    }

    private fun isUsernameTakenLocked(username: String, excludeRole: String? = null, excludeId: Long? = null): Boolean {
        val clean = username.lowercase(Locale.US)
        val superAdmin = db.optJSONObject("superAdmin")
        if (superAdmin != null &&
            superAdmin.optString("username", "").lowercase(Locale.US) == clean &&
            !(excludeRole == "SUPER_ADMIN" && superAdmin.optLong("id", -1L) == excludeId)
        ) {
            return true
        }
        val itAdmins = db.optJSONArray("itAdmins") ?: JSONArray()
        for (i in 0 until itAdmins.length()) {
            val a = itAdmins.optJSONObject(i) ?: continue
            if (a.optString("username", "").lowercase(Locale.US) == clean &&
                !(excludeRole == "IT_ADMIN" && a.optLong("id", -1L) == excludeId)
            ) {
                return true
            }
        }
        val teachers = db.optJSONArray("teachers") ?: JSONArray()
        for (i in 0 until teachers.length()) {
            val t = teachers.optJSONObject(i) ?: continue
            if (t.optString("username", "").lowercase(Locale.US) == clean &&
                !(excludeRole == "TEACHER" && t.optLong("id", -1L) == excludeId)
            ) {
                return true
            }
        }
        return false
    }

    private fun getAuthenticatedUser(headers: Map<String, String>, out: OutputStream): AuthUser? {
        val authHeader = headers["authorization"] ?: ""
        val token = if (authHeader.startsWith("Bearer ", ignoreCase = true)) {
            authHeader.substring(7).trim()
        } else {
            ""
        }
        val user = verifySessionToken(token)
        if (user == null) {
            sendJson(out, 401, JSONObject().put("error", "Tizimga qayta kiring (sessiya tugagan)"))
            return null
        }
        return user
    }

    private fun requireAdminUser(user: AuthUser, out: OutputStream): Boolean {
        if (user.role != "SUPER_ADMIN" && user.role != "IT_ADMIN") {
            sendJson(out, 403, JSONObject().put("error", "Bu amal faqat Super Admin va IT Adminlar uchun"))
            return false
        }
        return true
    }

    private fun requireSuperAdminUser(user: AuthUser, out: OutputStream): Boolean {
        if (user.role != "SUPER_ADMIN") {
            sendJson(out, 403, JSONObject().put("error", "Bu amal faqat Bosh Admin (Super Admin) uchun"))
            return false
        }
        return true
    }

    private fun createSessionToken(user: AuthUser): String {
        val payloadObj = JSONObject().apply {
            put("id", user.id)
            put("role", user.role)
            put("username", user.username)
            put("exp", System.currentTimeMillis() + 7L * 24L * 60L * 60L * 1000L)
        }
        val flags = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
        val payloadB64 = Base64.encodeToString(payloadObj.toString().toByteArray(Charsets.UTF_8), flags)
        val sigB64 = hmacSha256Base64Url(payloadB64, db.optString("sessionSecret", "smartboard-secret"))
        return "$payloadB64.$sigB64"
    }

    private fun verifySessionToken(token: String): AuthUser? {
        val dotIdx = token.indexOf('.')
        if (dotIdx <= 0 || dotIdx >= token.length - 1) return null
        val payloadB64 = token.substring(0, dotIdx)
        val sigB64 = token.substring(dotIdx + 1)

        val secret = synchronized(dbLock) { db.optString("sessionSecret", "smartboard-secret") }
        val expectedSig = hmacSha256Base64Url(payloadB64, secret)
        if (!MessageDigest.isEqual(sigB64.toByteArray(Charsets.UTF_8), expectedSig.toByteArray(Charsets.UTF_8))) {
            return null
        }

        return try {
            val flags = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
            val jsonStr = String(Base64.decode(payloadB64, flags), Charsets.UTF_8)
            val payload = JSONObject(jsonStr)
            val exp = payload.optLong("exp", 0L)
            if (exp < System.currentTimeMillis()) return null
            val role = payload.optString("role", "")
            val id = payload.optLong("id", -1L)
            synchronized(dbLock) {
                val rec = findRecordByRoleAndIdLocked(role, id) ?: return@synchronized null
                AuthUser(
                    id = rec.optLong("id", id),
                    username = rec.optString("username", ""),
                    name = rec.optString("name", ""),
                    role = role
                )
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun hmacSha256Base64Url(data: String, secret: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        val raw = mac.doFinal(data.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(raw, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    private fun hashPassword(password: String): String {
        val salt = ByteArray(16).also { random.nextBytes(it) }
        val saltHex = salt.joinToString("") { "%02x".format(it) }
        val digest = deriveKeySha256(password, saltHex)
        return "$saltHex:$digest"
    }

    private fun verifyPassword(password: String, storedHash: String): Boolean {
        val parts = storedHash.split(":")
        if (parts.size != 2) return false
        val saltHex = parts[0]
        val expectedHex = parts[1]
        if (saltHex.isBlank() || expectedHex.isBlank()) return false
        val derivedHex = deriveKeySha256(password, saltHex)
        return MessageDigest.isEqual(
            derivedHex.toByteArray(Charsets.UTF_8),
            expectedHex.toByteArray(Charsets.UTF_8)
        )
    }

    private fun deriveKeySha256(password: String, saltHex: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        var current = "$saltHex:$password".toByteArray(Charsets.UTF_8)
        repeat(2000) {
            md.reset()
            current = md.digest(current)
        }
        return current.joinToString("") { "%02x".format(it) }
    }

    private fun normalizeUsername(raw: String, fallback: String): String {
        val cleaned = raw.trim().lowercase(Locale.US).replace(Regex("[^a-z0-9._-]"), "")
        return cleaned.ifBlank { fallback }
    }

    private fun decodeSegment(raw: String): String {
        return try {
            URLDecoder.decode(raw, "UTF-8")
        } catch (_: Exception) {
            raw
        }
    }

    private fun generateNumericId(): Long = System.currentTimeMillis() + random.nextInt(1000)

    private fun getFormattedTime(): String {
        val sdf = SimpleDateFormat("HH:mm:ss/dd/MM/yyyy", Locale.US)
        return sdf.format(Date())
    }

    private fun sendJson(out: OutputStream, statusCode: Int, json: JSONObject) {
        val bytes = json.toString().toByteArray(Charsets.UTF_8)
        sendBytes(out, statusCode, bytes, "application/json; charset=utf-8", false)
    }

    private fun sendText(out: OutputStream, statusCode: Int, text: String) {
        val bytes = text.toByteArray(Charsets.UTF_8)
        sendBytes(out, statusCode, bytes, "text/plain; charset=utf-8", false)
    }

    private fun sendEmpty(out: OutputStream, statusCode: Int) {
        val statusText = statusReason(statusCode)
        val headers = buildString {
            append("HTTP/1.1 $statusCode $statusText\r\n")
            append("Access-Control-Allow-Origin: *\r\n")
            append("Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n")
            append("Access-Control-Allow-Headers: Content-Type, Authorization\r\n")
            append("Content-Length: 0\r\n")
            append("Connection: close\r\n\r\n")
        }
        out.write(headers.toByteArray(Charsets.ISO_8859_1))
        out.flush()
    }

    private fun sendBytes(
        out: OutputStream,
        statusCode: Int,
        body: ByteArray,
        contentType: String,
        headersOnly: Boolean
    ) {
        val statusText = statusReason(statusCode)
        val headers = buildString {
            append("HTTP/1.1 $statusCode $statusText\r\n")
            append("Content-Type: $contentType\r\n")
            append("Content-Length: ${body.size}\r\n")
            append("Access-Control-Allow-Origin: *\r\n")
            append("Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n")
            append("Access-Control-Allow-Headers: Content-Type, Authorization\r\n")
            append("Cache-Control: no-store\r\n")
            append("Connection: close\r\n\r\n")
        }
        out.write(headers.toByteArray(Charsets.ISO_8859_1))
        if (!headersOnly) {
            out.write(body)
        }
        out.flush()
    }

    private fun statusReason(code: Int): String = when (code) {
        200 -> "OK"
        204 -> "No Content"
        400 -> "Bad Request"
        401 -> "Unauthorized"
        403 -> "Forbidden"
        404 -> "Not Found"
        else -> "Internal Server Error"
    }

    companion object {
        const val DEFAULT_PORT = 3000
        const val DISCOVERY_UDP_PORT = 3001
        private const val DISCOVERY_REQUEST_MSG = "SMARTBOARD_MASTER_DISCOVER"
        private const val DISCOVERY_RESPONSE_PREFIX = "SMARTBOARD_MASTER_HERE:"

        fun getLocalWifiUrls(port: Int = DEFAULT_PORT): List<String> {
            val urls = mutableListOf<String>()
            try {
                val interfaces = NetworkInterface.getNetworkInterfaces() ?: return emptyList()
                val sorted = Collections.list(interfaces).sortedBy { nif ->
                    val name = nif.name.lowercase(Locale.US)
                    when {
                        name.startsWith("wlan") -> 0
                        name.startsWith("eth") -> 1
                        else -> 2
                    }
                }
                for (nif in sorted) {
                    if (nif.isLoopback || !nif.isUp) continue
                    for (addr in Collections.list(nif.inetAddresses)) {
                        if (addr is Inet4Address && !addr.isLoopbackAddress) {
                            val ip = addr.hostAddress ?: continue
                            urls.add("http://$ip:$port")
                        }
                    }
                }
            } catch (_: Exception) {}
            return urls.distinct()
        }

        fun discoverMasterServerUrl(timeoutMs: Long = 1300L): String? {
            var socket: DatagramSocket? = null
            return try {
                socket = DatagramSocket().apply {
                    broadcast = true
                    soTimeout = 450
                }
                val requestData = DISCOVERY_REQUEST_MSG.toByteArray(Charsets.UTF_8)
                val targets = LinkedHashSet<InetAddress>()
                try {
                    targets.add(InetAddress.getByName("255.255.255.255"))
                } catch (_: Exception) {}

                try {
                    val ifaces = NetworkInterface.getNetworkInterfaces()
                    if (ifaces != null) {
                        for (nif in Collections.list(ifaces)) {
                            if (nif.isLoopback || !nif.isUp) continue
                            for (ifAddr in nif.interfaceAddresses) {
                                ifAddr.broadcast?.let { targets.add(it) }
                            }
                        }
                    }
                } catch (_: Exception) {}

                val deadline = System.currentTimeMillis() + timeoutMs
                var attempt = 0
                val replyBuf = ByteArray(512)
                while (System.currentTimeMillis() < deadline && attempt < 2) {
                    attempt++
                    for (targetAddr in targets) {
                        try {
                            socket.send(DatagramPacket(requestData, requestData.size, targetAddr, DISCOVERY_UDP_PORT))
                        } catch (_: Exception) {}
                    }

                    val waitEnd = minOf(deadline, System.currentTimeMillis() + (timeoutMs / 2))
                    while (System.currentTimeMillis() < waitEnd) {
                        try {
                            val packet = DatagramPacket(replyBuf, replyBuf.size)
                            socket.receive(packet)
                            val msg = String(packet.data, 0, packet.length, Charsets.UTF_8).trim()
                            if (msg.startsWith(DISCOVERY_RESPONSE_PREFIX)) {
                                val candidate = msg.removePrefix(DISCOVERY_RESPONSE_PREFIX).trim().removeSuffix("/")
                                if (candidate.startsWith("http://") && isHealthOk(candidate)) {
                                    return candidate
                                }
                            }
                        } catch (_: SocketTimeoutException) {
                            break
                        } catch (_: Exception) {}
                    }
                }
                null
            } catch (_: Exception) {
                null
            } finally {
                try { socket?.close() } catch (_: Exception) {}
            }
        }

        private fun isHealthOk(baseUrl: String): Boolean {
            return try {
                val conn = (URL("$baseUrl/health").openConnection() as HttpURLConnection).apply {
                    connectTimeout = 900
                    readTimeout = 900
                    requestMethod = "GET"
                }
                val code = conn.responseCode
                conn.disconnect()
                code in 200..299
            } catch (_: Exception) {
                false
            }
        }
    }
}
