package com.example

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.example.model.SmartBoardConfig
import com.example.model.SmartBoardPreferences
import com.example.server.EmbeddedWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URL

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class EmbeddedWebServerTest {

    private lateinit var context: Context
    private var testPort: Int = 0
    private lateinit var server: EmbeddedWebServer

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        File(context.filesDir, "smartboard_web_db.json").delete()
        testPort = ServerSocket(0).use { it.localPort }
        server = EmbeddedWebServer(context, port = testPort)
        assertTrue(server.start())
    }

    @After
    fun tearDown() {
        server.stop()
    }

    private fun request(
        method: String,
        path: String,
        body: JSONObject? = null,
        token: String? = null
    ): Pair<Int, String> {
        val conn = (URL("http://127.0.0.1:$testPort$path").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 3000
            readTimeout = 3000
            setRequestProperty("Content-Type", "application/json")
            if (!token.isNullOrBlank()) {
                setRequestProperty("Authorization", "Bearer $token")
            }
            if (body != null) {
                doOutput = true
                outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
        }
        val code = conn.responseCode
        val stream = if (code in 200..399) conn.inputStream else conn.errorStream
        val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
        conn.disconnect()
        return code to text
    }

    @Test
    fun `embedded web server serves website and handles auth rooms and board unlock`() {
        val (healthCode, healthBody) = request("GET", "/health")
        assertEquals(200, healthCode)
        assertEquals("OK", healthBody)

        val (htmlCode, htmlBody) = request("GET", "/")
        assertEquals(200, htmlCode)
        assertTrue(htmlBody.contains("SmartBoard 86"))

        // Bad login rejected
        val (badCode, _) = request(
            "POST",
            "/api/auth/login",
            JSONObject().put("username", "admin").put("password", "wrong")
        )
        assertEquals(401, badCode)

        // Valid admin login
        val (loginCode, loginText) = request(
            "POST",
            "/api/auth/login",
            JSONObject().put("username", "admin").put("password", "admin1234")
        )
        assertEquals(200, loginCode)
        val loginJson = JSONObject(loginText)
        val token = loginJson.getString("token")
        assertTrue(token.isNotBlank())

        // Add room
        val (addRoomCode, _) = request(
            "POST",
            "/api/rooms",
            JSONObject().put("id", "AA:BB:CC:DD:EE:01").put("name", "101-Fizika"),
            token = token
        )
        assertEquals(200, addRoomCode)

        // Reject ALL bulk command
        val (bulkCode, _) = request(
            "POST",
            "/api/boards/action",
            JSONObject().put("action", "unlock").put("targetRoomId", "ALL"),
            token = token
        )
        assertEquals(400, bulkCode)

        // Unlock specific board
        val (unlockCode, _) = request(
            "POST",
            "/api/boards/action",
            JSONObject().put("action", "unlock").put("targetRoomId", "AA:BB:CC:DD:EE:01").put("durationMinutes", 45),
            token = token
        )
        assertEquals(200, unlockCode)

        // Board polls and receives UNLOCK command
        val (pollCode, pollText) = request(
            "POST",
            "/api/board/poll",
            JSONObject()
                .put("mac", "AA:BB:CC:DD:EE:01")
                .put("boardId", "BOARD_01")
                .put("isLocked", true)
                .put("secondsRemaining", 0)
        )
        assertEquals(200, pollCode)
        val pollJson = JSONObject(pollText)
        assertTrue(pollJson.getBoolean("isRegistered"))
        assertEquals("101-Fizika", pollJson.getString("registeredRoomName"))
        val cmd = pollJson.optJSONObject("command")
        assertNotNull(cmd)
        assertEquals("UNLOCK", cmd!!.getString("type"))
        assertEquals(45, cmd.getInt("durationMinutes"))

        // Delete all rooms
        val (delAllCode, _) = request("DELETE", "/api/rooms", token = token)
        assertEquals(200, delAllCode)
    }

    @Test
    fun `first install role flags persist master vs secondary client correctly`() {
        val prefs = SmartBoardPreferences(context)
        assertFalse(prefs.hasMasterRoleInitialized())

        prefs.markMasterRoleInitialized(isMaster = true, resolvedServerUrl = SmartBoardConfig.DEFAULT_SERVER_URL)
        assertTrue(prefs.hasMasterRoleInitialized())
        val masterCfg = prefs.loadConfig()
        assertTrue(masterCfg.isLocalWebServerEnabled)
        assertEquals("http://127.0.0.1:3000", masterCfg.serverUrl)

        prefs.markMasterRoleInitialized(isMaster = false, resolvedServerUrl = "http://192.168.100.101:3000")
        val clientCfg = prefs.loadConfig()
        assertFalse(clientCfg.isLocalWebServerEnabled)
        assertEquals("http://192.168.100.101:3000", clientCfg.serverUrl)
    }
}
