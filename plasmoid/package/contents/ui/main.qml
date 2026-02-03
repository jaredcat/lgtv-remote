import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC2
import org.kde.plasma.plasmoid
import org.kde.plasma.components as PlasmaComponents
import org.kde.plasma.plasma5support as Plasma5Support
import org.kde.kirigami as Kirigami

PlasmoidItem {
    id: root

    // Widget properties
    preferredRepresentation: fullRepresentation
    toolTipMainText: "LG TV Remote"
    toolTipSubText: tvConnected ? "Connected to " + tvName : "Not Connected"

    // TV connection state (stored in plasmoid config)
    property string tvName: Plasmoid.configuration.tvName || ""
    property string tvIp: Plasmoid.configuration.tvIp || ""
    property bool useSsl: Plasmoid.configuration.useSsl !== undefined ? Plasmoid.configuration.useSsl : true
    property bool tvConnected: tvName !== "" && tvIp !== ""
    property string statusMessage: tvConnected ? "Ready" : "Not connected"
    property string tvMac: Plasmoid.configuration.tvMac || ""

    property bool settingsExpanded: false
    property bool shortcutsExpanded: false

    property bool wakeStreamingOnPowerOn: Plasmoid.configuration.wakeStreamingOnPowerOn || false
    property string streamingDeviceType: Plasmoid.configuration.streamingDeviceType || ""
    property string streamingDeviceMac: Plasmoid.configuration.streamingDeviceMac || ""
    property string streamingDeviceBroadcastIp: Plasmoid.configuration.streamingDeviceBroadcastIp || ""
    property string streamingDeviceIp: Plasmoid.configuration.streamingDeviceIp || ""
    property int streamingDevicePort: Plasmoid.configuration.streamingDevicePort !== undefined ? Plasmoid.configuration.streamingDevicePort : 5555
    property bool hasStreamingDevice: streamingDeviceType === "wol" && streamingDeviceMac !== "" || streamingDeviceType === "adb" && streamingDeviceIp !== "" || streamingDeviceType === "roku" && streamingDeviceIp !== ""

    // Configurable shortcuts (when widget has focus); defaults from main.xml
    property string shortcutUp: Plasmoid.configuration.shortcutUp || "Up"
    property string shortcutDown: Plasmoid.configuration.shortcutDown || "Down"
    property string shortcutLeft: Plasmoid.configuration.shortcutLeft || "Left"
    property string shortcutRight: Plasmoid.configuration.shortcutRight || "Right"
    property string shortcutEnter: Plasmoid.configuration.shortcutEnter || "Return"
    property string shortcutBack: Plasmoid.configuration.shortcutBack || "Backspace"
    property string shortcutRewind: Plasmoid.configuration.shortcutRewind || "["
    property string shortcutPlay: Plasmoid.configuration.shortcutPlay || "Space"
    property string shortcutPause: Plasmoid.configuration.shortcutPause || "P"
    property string shortcutStop: Plasmoid.configuration.shortcutStop || "S"
    property string shortcutFastForward: Plasmoid.configuration.shortcutFastForward || "]"
    property string shortcutHome: Plasmoid.configuration.shortcutHome || "Home"
    property string shortcutVolumeUp: Plasmoid.configuration.shortcutVolumeUp || "="
    property string shortcutVolumeDown: Plasmoid.configuration.shortcutVolumeDown || "-"
    property string shortcutMute: Plasmoid.configuration.shortcutMute || "Shift+-"
    property string shortcutUnmute: Plasmoid.configuration.shortcutUnmute || "Shift+="
    property string shortcutPowerOn: Plasmoid.configuration.shortcutPowerOn || "F7"
    property string shortcutPowerOff: Plasmoid.configuration.shortcutPowerOff || "F8"
    property string shortcutWakeStreaming: Plasmoid.configuration.shortcutWakeStreaming || ""
    property string appVersion: "2.0"

    // Path to bundled Python scripts
    readonly property string scriptPath: Qt.resolvedUrl("../code/lgtv_remote.py").toString().replace("file://", "")
    readonly property string daemonPath: Qt.resolvedUrl("../code/lgtv_daemon.py").toString().replace("file://", "")
    
    // Track if daemon is connected to TV
    property bool daemonConnected: false

    // Executable DataSource for running commands
    Plasma5Support.DataSource {
        id: executable
        engine: "executable"
        connectedSources: []

        onNewData: function(source, data) {
            var stdout = data["stdout"] || ""
            var stderr = data["stderr"] || ""
            var exitCode = data["exit code"]

            // Parse JSON response
            var result = null
            try {
                result = JSON.parse(stdout)
            } catch (e) {}

            // Handle daemon status check
            if (source.indexOf("status") !== -1) {
                if (result && result.running) {
                    var wasConnected = daemonConnected
                    daemonConnected = result.connected || false
                    if (wasConnected && !daemonConnected) {
                        statusMessage = "Connection lost"
                    }
                    if (!daemonConnected && tvConnected) {
                        connectDaemon()
                    }
                } else {
                    daemonConnected = false
                    startDaemon()
                }
                executable.disconnectSource(source)
                return
            }
            
            // Handle daemon start
            if (source.indexOf("start") !== -1) {
                // Give daemon time to start, then connect
                daemonStartTimer.start()
                executable.disconnectSource(source)
                return
            }
            
            // Handle connect response
            if (source.indexOf("connect") !== -1) {
                if (result && result.success) {
                    daemonConnected = true
                    statusMessage = "Connected"
                } else {
                    daemonConnected = false
                    statusMessage = "Connection failed"
                }
                statusTimer.restart()
                executable.disconnectSource(source)
                return
            }

            // Handle regular command response
            if (result && result.success) {
                statusMessage = result.message || "OK"
                // After Fetch MAC, update TV MAC field from message (e.g. "MAC address saved: AA:BB:CC:DD:EE:FF")
                if (result.message && result.message.indexOf("MAC address saved:") === 0) {
                    var mac = result.message.replace("MAC address saved:", "").trim()
                    if (mac) Plasmoid.configuration.tvMac = mac
                }
            } else if (result && result.error) {
                statusMessage = "Error"
                // If daemon reports not connected, try reconnecting
                if (result.error.indexOf("Not connected") !== -1) {
                    daemonConnected = false
                }
            }

            statusTimer.restart()
            executable.disconnectSource(source)
        }

        function exec(cmd) {
            executable.connectSource(cmd)
        }
    }
    
    // Timer to wait for daemon to start
    Timer {
        id: daemonStartTimer
        interval: 500
        onTriggered: connectDaemon()
    }
    
    // Check daemon status periodically
    Timer {
        id: daemonCheckTimer
        interval: 30000  // Check every 30 seconds
        running: true
        repeat: true
        onTriggered: checkDaemon()
    }
    
    function startDaemon() {
        executable.exec("python3 '" + daemonPath + "' start")
    }
    
    function checkDaemon() {
        executable.exec("python3 '" + daemonPath + "' status")
    }
    
    function connectDaemon() {
        if (tvName && tvIp) {
            var sslFlag = useSsl ? "" : " --no-ssl"
            executable.exec("python3 '" + daemonPath + "' connect '" + tvName + "' " + tvIp + sslFlag)
        }
    }
    
    Component.onCompleted: {
        // Start daemon check on widget load
        checkDaemon()
    }

    Timer {
        id: statusTimer
        interval: 1500
        onTriggered: {
            statusMessage = tvConnected ? "Ready" : "Not connected"
        }
    }

    // Send command to TV via daemon (fast) or fallback to direct script (slow)
    function sendCommand(command, args) {
        if (!tvConnected) {
            statusMessage = "Not connected"
            return
        }

        var argsStr = args ? args.join(",") : ""
        
        if (daemonConnected) {
            // Fast path: use daemon
            executable.exec("python3 '" + daemonPath + "' send " + command + " '" + argsStr + "'")
        } else {
            // Slow path: direct script (also tries to start daemon)
            var sslFlag = useSsl ? "" : " --no-ssl"
            executable.exec("python3 '" + scriptPath + "' send '" + tvName + "' " + command + " '" + argsStr + "'" + sslFlag)
            // Try to start daemon for next time
            checkDaemon()
        }
    }

    function scanForTVs() {
        statusMessage = "Listing saved TVs..."
        executable.exec("python3 '" + scriptPath + "' list")
    }

    function authenticateTV() {
        if (tvIp === "" || tvName === "") {
            statusMessage = "Please enter TV name and IP"
            return
        }

        statusMessage = "Authenticating... Accept on TV screen"
        var sslFlag = useSsl ? "" : " --no-ssl"
        var cmd = "python3 '" + scriptPath + "' auth " + tvIp + " '" + tvName + "'" + sslFlag
        executable.exec(cmd)
        
        // After auth, restart daemon to pick up new key
        daemonConnected = false
    }

    function fetchMac() {
        if (!daemonConnected) return
        executable.exec("python3 '" + daemonPath + "' send fetch_mac ''")
    }

    function buildStreamingDeviceJson() {
        if (streamingDeviceType === "wol" && streamingDeviceMac)
            return '{"type":"wol","mac":"' + streamingDeviceMac.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"' + (streamingDeviceBroadcastIp ? ',"broadcast_ip":"' + streamingDeviceBroadcastIp.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"' : '') + '}'
        if (streamingDeviceType === "adb" && streamingDeviceIp)
            return '{"type":"adb","ip":"' + streamingDeviceIp.replace(/"/g, '\\"') + '","port":' + streamingDevicePort + '}'
        if (streamingDeviceType === "roku" && streamingDeviceIp)
            return '{"type":"roku","ip":"' + streamingDeviceIp.replace(/"/g, '\\"') + '"}'
        return 'null'
    }

    function pushStreamingConfigToDaemon() {
        var deviceJson = buildStreamingDeviceJson()
        var escaped = deviceJson.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        executable.exec("python3 '" + daemonPath + "' setconfig streaming_device \"" + escaped + "\"")
        executable.exec("python3 '" + daemonPath + "' setconfig wake_streaming_on_power_on " + (wakeStreamingOnPowerOn ? "true" : "false"))
    }

    function saveTvMac() {
        if (tvName && tvMac && tvMac.replace(/[\s:\-]/g, "").length === 12) {
            executable.exec("python3 '" + daemonPath + "' setmac '" + tvName.replace(/'/g, "'\\''") + "' '" + tvMac.replace(/'/g, "'\\''") + "'")
        }
    }

    function saveSettings() {
        Plasmoid.configuration.tvName = tvName
        Plasmoid.configuration.tvIp = tvIp
        Plasmoid.configuration.useSsl = useSsl
        Plasmoid.configuration.wakeStreamingOnPowerOn = wakeStreamingOnPowerOn
        Plasmoid.configuration.streamingDeviceType = streamingDeviceType
        Plasmoid.configuration.streamingDeviceMac = streamingDeviceMac
        Plasmoid.configuration.streamingDeviceBroadcastIp = streamingDeviceBroadcastIp
        Plasmoid.configuration.streamingDeviceIp = streamingDeviceIp
        Plasmoid.configuration.streamingDevicePort = streamingDevicePort
        pushStreamingConfigToDaemon()
    }

    // Keyboard shortcuts
    Keys.onPressed: function(event) {
        if (!tvConnected) return

        var hasShift = event.modifiers & Qt.ShiftModifier

        switch(event.key) {
            case Qt.Key_Up:
                sendCommand("sendButton", ["UP"])
                event.accepted = true
                break
            case Qt.Key_Down:
                sendCommand("sendButton", ["DOWN"])
                event.accepted = true
                break
            case Qt.Key_Left:
                sendCommand("sendButton", ["LEFT"])
                event.accepted = true
                break
            case Qt.Key_Right:
                sendCommand("sendButton", ["RIGHT"])
                event.accepted = true
                break
            case Qt.Key_Return:
            case Qt.Key_Enter:
                sendCommand("sendButton", ["ENTER"])
                event.accepted = true
                break
            case Qt.Key_Backspace:
            case Qt.Key_Escape:
                sendCommand("sendButton", ["BACK"])
                event.accepted = true
                break
            case Qt.Key_Equal:
            case Qt.Key_Plus:
                if (hasShift) {
                    sendCommand("mute", ["false"])  // Shift+= unmutes
                } else {
                    sendCommand("volumeUp")
                }
                event.accepted = true
                break
            case Qt.Key_Minus:
            case Qt.Key_Underscore:
                if (hasShift) {
                    sendCommand("mute", ["true"])  // Shift+- mutes
                } else {
                    sendCommand("volumeDown")
                }
                event.accepted = true
                break
        }
    }

    fullRepresentation: Item {
        Layout.minimumWidth: Kirigami.Units.gridUnit * 18
        Layout.minimumHeight: Kirigami.Units.gridUnit * 28
        Layout.preferredWidth: Kirigami.Units.gridUnit * 20
        Layout.preferredHeight: Kirigami.Units.gridUnit * 32

        focus: true
        Keys.forwardTo: [root]

        // Configurable shortcuts (when widget has focus and sequence is set)
        Shortcut { sequence: root.shortcutUp; enabled: root.shortcutUp !== "" && root.tvConnected; onActivated: root.sendCommand("sendButton", ["UP"]) }
        Shortcut { sequence: root.shortcutDown; enabled: root.shortcutDown !== "" && root.tvConnected; onActivated: root.sendCommand("sendButton", ["DOWN"]) }
        Shortcut { sequence: root.shortcutLeft; enabled: root.shortcutLeft !== "" && root.tvConnected; onActivated: root.sendCommand("sendButton", ["LEFT"]) }
        Shortcut { sequence: root.shortcutRight; enabled: root.shortcutRight !== "" && root.tvConnected; onActivated: root.sendCommand("sendButton", ["RIGHT"]) }
        Shortcut { sequence: root.shortcutEnter; enabled: root.shortcutEnter !== "" && root.tvConnected; onActivated: root.sendCommand("sendButton", ["ENTER"]) }
        Shortcut { sequence: root.shortcutBack; enabled: root.shortcutBack !== "" && root.tvConnected; onActivated: root.sendCommand("sendButton", ["BACK"]) }
        Shortcut { sequence: root.shortcutRewind; enabled: root.shortcutRewind !== "" && root.tvConnected; onActivated: root.sendCommand("sendButton", ["REWIND"]) }
        Shortcut { sequence: root.shortcutPlay; enabled: root.shortcutPlay !== "" && root.tvConnected; onActivated: root.sendCommand("sendButton", ["PLAY"]) }
        Shortcut { sequence: root.shortcutPause; enabled: root.shortcutPause !== "" && root.tvConnected; onActivated: root.sendCommand("sendButton", ["PAUSE"]) }
        Shortcut { sequence: root.shortcutStop; enabled: root.shortcutStop !== "" && root.tvConnected; onActivated: root.sendCommand("sendButton", ["STOP"]) }
        Shortcut { sequence: root.shortcutFastForward; enabled: root.shortcutFastForward !== "" && root.tvConnected; onActivated: root.sendCommand("sendButton", ["FASTFORWARD"]) }
        Shortcut { sequence: root.shortcutHome; enabled: root.shortcutHome !== "" && root.tvConnected; onActivated: root.sendCommand("sendButton", ["HOME"]) }
        Shortcut { sequence: root.shortcutVolumeUp; enabled: root.shortcutVolumeUp !== "" && root.tvConnected; onActivated: root.sendCommand("volumeUp") }
        Shortcut { sequence: root.shortcutVolumeDown; enabled: root.shortcutVolumeDown !== "" && root.tvConnected; onActivated: root.sendCommand("volumeDown") }
        Shortcut { sequence: root.shortcutMute; enabled: root.shortcutMute !== "" && root.tvConnected; onActivated: root.sendCommand("mute", ["true"]) }
        Shortcut { sequence: root.shortcutUnmute; enabled: root.shortcutUnmute !== "" && root.tvConnected; onActivated: root.sendCommand("mute", ["false"]) }
        Shortcut { sequence: root.shortcutPowerOn; enabled: root.shortcutPowerOn !== "" && root.tvConnected; onActivated: root.sendCommand("on") }
        Shortcut { sequence: root.shortcutPowerOff; enabled: root.shortcutPowerOff !== "" && root.tvConnected; onActivated: root.sendCommand("off") }
        Shortcut { sequence: root.shortcutWakeStreaming; enabled: root.shortcutWakeStreaming !== "" && root.hasStreamingDevice; onActivated: root.sendCommand("wake_streaming_device") }

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: Kirigami.Units.smallSpacing

            // Header
            RowLayout {
                Layout.fillWidth: true

                Kirigami.Heading {
                    text: "LG TV Remote"
                    level: 2
                }

                Item { Layout.fillWidth: true }

                PlasmaComponents.Label {
                    text: root.statusMessage
                    color: root.tvConnected ? Kirigami.Theme.positiveTextColor : Kirigami.Theme.negativeTextColor
                }
            }

            // Settings (collapsible): Connection + streaming device + version
            Kirigami.Separator { Layout.fillWidth: true }
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 0
                MouseArea {
                    Layout.fillWidth: true
                    implicitHeight: settingsHeaderRow.implicitHeight
                    onClicked: root.settingsExpanded = !root.settingsExpanded
                    RowLayout {
                        id: settingsHeaderRow
                        anchors.fill: parent
                        PlasmaComponents.Label {
                            text: "Settings"
                            font.bold: true
                        }
                        Item { Layout.fillWidth: true }
                        Kirigami.Icon {
                            source: "arrow-down"
                            width: Kirigami.Units.iconSizes.small
                            height: width
                            rotation: root.settingsExpanded ? 0 : -90
                        }
                    }
                }
                ColumnLayout {
                    id: settingsContent
                    Layout.fillWidth: true
                    visible: root.settingsExpanded
                    spacing: Kirigami.Units.smallSpacing
                    Layout.topMargin: root.settingsExpanded ? Kirigami.Units.smallSpacing : 0

                    // Connection (inside Settings, like tray app)
                    PlasmaComponents.Label { text: "Connection"; font.bold: true }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "TV Name:"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField {
                            id: tvNameField
                            Layout.fillWidth: true
                            text: root.tvName
                            placeholderText: "e.g., LivingRoomTV"
                            onTextChanged: { root.tvName = text; root.saveSettings() }
                        }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "TV IP:"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField {
                            id: tvIpField
                            Layout.fillWidth: true
                            text: root.tvIp
                            placeholderText: "192.168.1.100"
                            onTextChanged: { root.tvIp = text; root.saveSettings() }
                        }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.CheckBox {
                            id: sslCheckbox
                            text: "Use SSL"
                            checked: root.useSsl
                            onCheckedChanged: { root.useSsl = checked; root.saveSettings() }
                        }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "TV MAC (Power On):"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField {
                            Layout.fillWidth: true
                            placeholderText: "AA:BB:CC:DD:EE:FF or use Fetch MAC when connected"
                            text: root.tvMac
                            onTextChanged: { Plasmoid.configuration.tvMac = text; root.saveTvMac() }
                        }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        Item { Layout.fillWidth: true }
                        PlasmaComponents.Button { text: "Scan"; icon.name: "view-refresh"; onClicked: root.scanForTVs() }
                        PlasmaComponents.Button { text: "Auth"; icon.name: "dialog-password"; enabled: root.tvName !== "" && root.tvIp !== ""; onClicked: root.authenticateTV() }
                        PlasmaComponents.Button { text: "Fetch MAC"; icon.name: "network-wired"; enabled: root.tvName !== "" && root.daemonConnected; onClicked: root.fetchMac() }
                    }
                    Kirigami.Separator { Layout.fillWidth: true }
                    PlasmaComponents.Label { text: "Streaming device"; font.bold: true }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Type:"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        QQC2.ComboBox {
                            id: streamingTypeCombo
                            Layout.fillWidth: true
                            model: ["None", "Wake-on-LAN (WoL)", "ADB (Android)", "Roku"]
                            property var values: ["", "wol", "adb", "roku"]
                            currentIndex: {
                                var i = values.indexOf(root.streamingDeviceType)
                                return i >= 0 ? i : 0
                            }
                            onActivated: {
                                Plasmoid.configuration.streamingDeviceType = values[currentIndex]
                                root.saveSettings()
                            }
                        }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        visible: root.streamingDeviceType !== ""
                        PlasmaComponents.CheckBox {
                            id: wakeStreamingCheck
                            text: "Wake streaming device when using Power On"
                            checked: root.wakeStreamingOnPowerOn
                            onCheckedChanged: {
                                Plasmoid.configuration.wakeStreamingOnPowerOn = checked
                                root.saveSettings()
                            }
                        }
                    }
                    RowLayout {
                        visible: root.streamingDeviceType === "wol"
                        PlasmaComponents.Label { text: "Device MAC (WoL):"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField {
                            Layout.fillWidth: true
                            placeholderText: "AA:BB:CC:DD:EE:FF"
                            text: root.streamingDeviceMac
                            onTextChanged: { Plasmoid.configuration.streamingDeviceMac = text; root.saveSettings() }
                        }
                    }
                    RowLayout {
                        visible: root.streamingDeviceType === "wol"
                        PlasmaComponents.Label { text: "Broadcast IP:"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField {
                            Layout.fillWidth: true
                            placeholderText: "optional, e.g. 10.0.0.255"
                            text: root.streamingDeviceBroadcastIp
                            onTextChanged: { Plasmoid.configuration.streamingDeviceBroadcastIp = text; root.saveSettings() }
                        }
                    }
                    RowLayout {
                        visible: root.streamingDeviceType === "adb" || root.streamingDeviceType === "roku"
                        PlasmaComponents.Label { text: "Device IP:"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField {
                            Layout.fillWidth: true
                            placeholderText: "192.168.1.101"
                            text: root.streamingDeviceIp
                            onTextChanged: { Plasmoid.configuration.streamingDeviceIp = text; root.saveSettings() }
                        }
                    }
                    RowLayout {
                        visible: root.streamingDeviceType === "adb"
                        PlasmaComponents.Label { text: "ADB port:"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField {
                            Layout.preferredWidth: Kirigami.Units.gridUnit * 4
                            placeholderText: "5555"
                            text: root.streamingDevicePort > 0 ? root.streamingDevicePort : ""
                            validator: IntValidator { bottom: 1; top: 65535 }
                            onTextChanged: {
                                var n = parseInt(text)
                                if (!isNaN(n)) { Plasmoid.configuration.streamingDevicePort = n; root.saveSettings() }
                            }
                        }
                    }
                    Kirigami.Separator { Layout.fillWidth: true }
                    RowLayout {
                        Layout.fillWidth: true
                        Item { Layout.fillWidth: true }
                        PlasmaComponents.Label {
                            text: "Version " + root.appVersion
                            font: Kirigami.Theme.smallFont
                            opacity: 0.8
                        }
                    }
                }
            }

            // Directional pad
            Kirigami.Separator { Layout.fillWidth: true }

            ColumnLayout {
                Layout.fillWidth: true

                PlasmaComponents.Label {
                    text: "Navigation"
                    font.bold: true
                }

                GridLayout {
                    Layout.alignment: Qt.AlignHCenter
                    columns: 3
                    rowSpacing: Kirigami.Units.smallSpacing
                    columnSpacing: Kirigami.Units.smallSpacing

                    Item { width: 50; height: 50 }
                    PlasmaComponents.Button {
                        icon.name: "arrow-up"
                        Layout.preferredWidth: 50
                        Layout.preferredHeight: 50
                        onClicked: root.sendCommand("sendButton", ["UP"])
                    }
                    Item { width: 50; height: 50 }

                    PlasmaComponents.Button {
                        icon.name: "arrow-left"
                        Layout.preferredWidth: 50
                        Layout.preferredHeight: 50
                        onClicked: root.sendCommand("sendButton", ["LEFT"])
                    }
                    PlasmaComponents.Button {
                        text: "OK"
                        Layout.preferredWidth: 50
                        Layout.preferredHeight: 50
                        onClicked: root.sendCommand("sendButton", ["ENTER"])
                    }
                    PlasmaComponents.Button {
                        icon.name: "arrow-right"
                        Layout.preferredWidth: 50
                        Layout.preferredHeight: 50
                        onClicked: root.sendCommand("sendButton", ["RIGHT"])
                    }

                    Item { width: 50; height: 50 }
                    PlasmaComponents.Button {
                        icon.name: "arrow-down"
                        Layout.preferredWidth: 50
                        Layout.preferredHeight: 50
                        onClicked: root.sendCommand("sendButton", ["DOWN"])
                    }
                    Item { width: 50; height: 50 }
                }
            }

            // Media controls
            Kirigami.Separator { Layout.fillWidth: true }

            ColumnLayout {
                Layout.fillWidth: true

                PlasmaComponents.Label {
                    text: "Media"
                    font.bold: true
                }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: Kirigami.Units.smallSpacing

                    PlasmaComponents.Button {
                        icon.name: "media-skip-backward"
                        Layout.fillWidth: true
                        PlasmaComponents.ToolTip { text: "Rewind" }
                        onClicked: root.sendCommand("sendButton", ["REWIND"])
                    }
                PlasmaComponents.Button {
                    icon.name: "media-playback-pause"
                    Layout.preferredWidth: 50
                    PlasmaComponents.ToolTip { text: "Pause" }
                    onClicked: root.sendCommand("sendButton", ["PAUSE"])
                }
                PlasmaComponents.Button {
                    icon.name: "media-playback-start"
                    Layout.preferredWidth: 50
                    PlasmaComponents.ToolTip { text: "Play" }
                    onClicked: root.sendCommand("sendButton", ["PLAY"])
                }
                PlasmaComponents.Button {
                    icon.name: "media-playback-stop"
                    Layout.preferredWidth: 50
                    PlasmaComponents.ToolTip { text: "Stop" }
                    onClicked: root.sendCommand("sendButton", ["STOP"])
                }
                PlasmaComponents.Button {
                    icon.name: "media-skip-forward"
                    Layout.fillWidth: true
                    PlasmaComponents.ToolTip { text: "Fast Forward" }
                    onClicked: root.sendCommand("sendButton", ["FASTFORWARD"])
                }
                }
            }

            // Volume controls
            Kirigami.Separator { Layout.fillWidth: true }

            RowLayout {
                Layout.fillWidth: true

                PlasmaComponents.Button {
                    text: "Vol -"
                    icon.name: "audio-volume-low"
                    Layout.fillWidth: true
                    onClicked: root.sendCommand("volumeDown")
                }

                PlasmaComponents.Button {
                    icon.name: "audio-volume-muted"
                    Layout.preferredWidth: 50
                    onClicked: root.sendCommand("mute", ["true"])
                    PlasmaComponents.ToolTip { text: "Mute (Shift+-)" }
                }

                PlasmaComponents.Button {
                    icon.name: "audio-volume-high"
                    Layout.preferredWidth: 50
                    onClicked: root.sendCommand("mute", ["false"])
                    PlasmaComponents.ToolTip { text: "Unmute (Shift+=)" }
                }

                PlasmaComponents.Button {
                    text: "Vol +"
                    icon.name: "audio-volume-high"
                    Layout.fillWidth: true
                    onClicked: root.sendCommand("volumeUp")
                }
            }

            // Quick actions
            Kirigami.Separator { Layout.fillWidth: true }

            GridLayout {
                Layout.fillWidth: true
                columns: 2
                rowSpacing: Kirigami.Units.smallSpacing
                columnSpacing: Kirigami.Units.smallSpacing

                PlasmaComponents.Button {
                    text: "Power On"
                    icon.name: "system-shutdown"
                    Layout.fillWidth: true
                    onClicked: root.sendCommand("on")
                }
                PlasmaComponents.Button {
                    text: "Power Off"
                    icon.name: "system-shutdown"
                    Layout.fillWidth: true
                    onClicked: root.sendCommand("off")
                }
                PlasmaComponents.Button {
                    text: "Home"
                    icon.name: "go-home"
                    Layout.fillWidth: true
                    onClicked: root.sendCommand("sendButton", ["HOME"])
                }
                PlasmaComponents.Button {
                    text: "Back"
                    icon.name: "go-previous"
                    Layout.fillWidth: true
                    onClicked: root.sendCommand("sendButton", ["BACK"])
                }
                PlasmaComponents.Button {
                    text: "Wake streaming"
                    icon.name: "preferences-system-power"
                    Layout.fillWidth: true
                    visible: root.hasStreamingDevice
                    onClicked: root.sendCommand("wake_streaming_device")
                }
            }

            // Keyboard shortcuts (collapsible, below all buttons like tray app)
            Kirigami.Separator { Layout.fillWidth: true }
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 0
                MouseArea {
                    Layout.fillWidth: true
                    implicitHeight: shortcutsHeaderRow.implicitHeight
                    onClicked: root.shortcutsExpanded = !root.shortcutsExpanded
                    RowLayout {
                        id: shortcutsHeaderRow
                        anchors.fill: parent
                        PlasmaComponents.Label { text: "⌨️ Keyboard shortcuts"; font.bold: true }
                        Item { Layout.fillWidth: true }
                        Kirigami.Icon { source: "arrow-down"; width: Kirigami.Units.iconSizes.small; height: width; rotation: root.shortcutsExpanded ? 0 : -90 }
                    }
                }
                ColumnLayout {
                    id: shortcutsContent
                    Layout.fillWidth: true
                    visible: root.shortcutsExpanded
                    spacing: Kirigami.Units.smallSpacing
                    Layout.topMargin: root.shortcutsExpanded ? Kirigami.Units.smallSpacing : 0
                    PlasmaComponents.Label {
                        text: "Shortcuts work when the widget popup is focused. For global hotkeys (when the widget is not focused), use the tray app."
                        wrapMode: Text.WordWrap
                        font: Kirigami.Theme.smallFont
                        opacity: 0.85
                        Layout.fillWidth: true
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Up"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutUp; onTextChanged: Plasmoid.configuration.shortcutUp = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Down"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutDown; onTextChanged: Plasmoid.configuration.shortcutDown = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Left"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutLeft; onTextChanged: Plasmoid.configuration.shortcutLeft = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Right"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutRight; onTextChanged: Plasmoid.configuration.shortcutRight = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "OK / Enter"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutEnter; onTextChanged: Plasmoid.configuration.shortcutEnter = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Back"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutBack; onTextChanged: Plasmoid.configuration.shortcutBack = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Rewind"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutRewind; onTextChanged: Plasmoid.configuration.shortcutRewind = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Play"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutPlay; onTextChanged: Plasmoid.configuration.shortcutPlay = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Pause"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutPause; onTextChanged: Plasmoid.configuration.shortcutPause = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Stop"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutStop; onTextChanged: Plasmoid.configuration.shortcutStop = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Fast Forward"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutFastForward; onTextChanged: Plasmoid.configuration.shortcutFastForward = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Home"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutHome; onTextChanged: Plasmoid.configuration.shortcutHome = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Volume Up"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutVolumeUp; onTextChanged: Plasmoid.configuration.shortcutVolumeUp = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Volume Down"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutVolumeDown; onTextChanged: Plasmoid.configuration.shortcutVolumeDown = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Mute"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutMute; onTextChanged: Plasmoid.configuration.shortcutMute = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Unmute"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutUnmute; onTextChanged: Plasmoid.configuration.shortcutUnmute = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Power On"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutPowerOn; onTextChanged: Plasmoid.configuration.shortcutPowerOn = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Power Off"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutPowerOff; onTextChanged: Plasmoid.configuration.shortcutPowerOff = text }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: "Wake streaming device"; Layout.minimumWidth: Kirigami.Units.gridUnit * 5 }
                        PlasmaComponents.TextField { Layout.fillWidth: true; text: root.shortcutWakeStreaming; onTextChanged: Plasmoid.configuration.shortcutWakeStreaming = text }
                    }
                }
            }

            PlasmaComponents.Label {
                Layout.fillWidth: true
                text: "Shortcuts work when the widget popup is focused. See Keyboard shortcuts above for defaults."
                wrapMode: Text.WordWrap
                font: Kirigami.Theme.smallFont
                opacity: 0.7
            }
            Item { Layout.fillHeight: true }
        }
    }

    compactRepresentation: Kirigami.Icon {
        source: "video-television"
        active: compactMouse.containsMouse

        MouseArea {
            id: compactMouse
            anchors.fill: parent
            hoverEnabled: true
            onClicked: root.expanded = !root.expanded
        }
    }
}
