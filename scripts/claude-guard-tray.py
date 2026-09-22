#!/usr/bin/env python3
"""
Claude-Guard Linux System Tray Indicator (StatusNotifierItem)
Integrates natively with GNOME Shell (Ubuntu AppIndicators), KDE, and XFCE.
"""

import sys
import os
import signal
import subprocess
import sqlite3
import argparse

try:
    import dbus
    import dbus.service
    from dbus.mainloop.glib import DBusGMainLoop
    from gi.repository import GLib
except ImportError as err:
    print(f"[claude-guard-tray] Dependências ausentes: {err}", file=sys.stderr)
    sys.exit(1)

def get_db_stats():
    db_path = os.path.expanduser("~/.config/claude-guard/history.db")
    if not os.path.exists(db_path):
        return 0, 0.0
    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("SELECT COALESCE(SUM(tokens_saved), 0), COALESCE(SUM(cost_saved), 0.0) FROM requests")
        row = cur.fetchone()
        conn.close()
        if row:
            return int(row[0] or 0), float(row[1] or 0.0)
    except Exception:
        pass
    return 0, 0.0

class DBusMenu(dbus.service.Object):
    def __init__(self, bus_name, port, on_quit):
        super().__init__(bus_name, '/MenuBar')
        self.port = port
        self.on_quit = on_quit
        self.revision = 1

    def _make_item(self, id_num, props):
        empty_children = dbus.Array([], signature='v')
        dbus_props = {}
        for k, v in props.items():
            if isinstance(v, bool):
                dbus_props[k] = dbus.Boolean(v)
            elif isinstance(v, int):
                dbus_props[k] = dbus.Int32(v)
            else:
                dbus_props[k] = dbus.String(str(v))
        return dbus.Struct((dbus.Int32(id_num), dbus.Dictionary(dbus_props, signature='sv'), empty_children), signature='(ia{sv}av)')

    @dbus.service.method('com.canonical.dbusmenu', in_signature='iias', out_signature='u(ia{sv}av)')
    def GetLayout(self, parent_id, recursion_depth, property_names):
        tokens, cost = get_db_stats()
        cost_str = f"${cost:.2f}"
        tokens_str = f"{tokens:,}".replace(',', '.')

        item1 = self._make_item(1, {'label': f'📊 Abrir Dashboard (Porta {self.port})', 'enabled': True})
        item2 = self._make_item(2, {'label': '🛡️ Status: Ativo (Claude & Codex)', 'enabled': False})
        item3 = self._make_item(3, {'label': f'⚡ Economia: ~{tokens_str} tokens ({cost_str})', 'enabled': False})
        item4 = self._make_item(4, {'type': 'separator'})
        item5 = self._make_item(5, {'label': '❌ Encerrar Claude-Guard', 'enabled': True})

        children = dbus.Array([item1, item2, item3, item4, item5], signature='v')
        root_props = dbus.Dictionary({'children-display': dbus.String('submenu')}, signature='sv')
        root_item = dbus.Struct((dbus.Int32(0), root_props, children), signature='(ia{sv}av)')

        return (dbus.UInt32(self.revision), root_item)

    @dbus.service.method('com.canonical.dbusmenu', in_signature='isvu')
    def Event(self, item_id, event_id, data, timestamp):
        if event_id == 'clicked':
            if item_id == 1:
                dashboard_url = f"http://127.0.0.1:{self.port}/dashboard"
                try:
                    subprocess.Popen(['xdg-open', dashboard_url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except Exception:
                    pass
            elif item_id == 5:
                if self.on_quit:
                    self.on_quit()

    @dbus.service.method('com.canonical.dbusmenu', in_signature='i', out_signature='b')
    def AboutToShow(self, item_id):
        self.revision += 1
        return True

    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='s', out_signature='a{sv}')
    def GetAll(self, interface):
        return {
            'Version': dbus.UInt32(3),
            'TextDirection': dbus.String('ltr'),
            'Status': dbus.String('normal')
        }

class StatusNotifierItem(dbus.service.Object):
    def __init__(self, bus_name, port, on_quit):
        super().__init__(bus_name, '/StatusNotifierItem')
        self.port = port
        self.on_quit = on_quit

        self.props = {
            'Category': dbus.String('ApplicationStatus'),
            'Id': dbus.String('claude-guard'),
            'Title': dbus.String('Claude-Guard'),
            'Status': dbus.String('Active'),
            'WindowId': dbus.Int32(0),
            'IconName': dbus.String('security-high'),
            'OverlayIconName': dbus.String(''),
            'AttentionIconName': dbus.String(''),
            'AttentionMovieName': dbus.String(''),
            'ItemIsMenu': dbus.Boolean(True),
            'Menu': dbus.ObjectPath('/MenuBar'),
            'ToolTip': dbus.Struct(
                (
                    dbus.String('security-high'),
                    dbus.Array([], signature='(iiay)'),
                    dbus.String(f'Claude-Guard 🛡️ (Porta {port})'),
                    dbus.String('Otimizador de Tokens e Firewall Local para Claude & Codex')
                ),
                signature='sa(iiay)ss'
            )
        }

    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='ss', out_signature='v')
    def Get(self, interface, prop):
        return self.props.get(prop, '')

    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='s', out_signature='a{sv}')
    def GetAll(self, interface):
        return self.props

    @dbus.service.method('org.kde.StatusNotifierItem', in_signature='ii')
    def Activate(self, x, y):
        dashboard_url = f"http://127.0.0.1:{self.port}/dashboard"
        try:
            subprocess.Popen(['xdg-open', dashboard_url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass

    @dbus.service.method('org.kde.StatusNotifierItem', in_signature='ii')
    def ContextMenu(self, x, y):
        pass

def main():
    parser = argparse.ArgumentParser(description="Claude-Guard System Tray Indicator")
    parser.add_argument('--port', type=int, default=int(os.environ.get('CLAUDE_GUARD_PORT', '48080')), help='Porta do proxy')
    parser.add_argument('--parent-pid', type=int, default=None, help='PID do processo pai a encerrar junto')
    args = parser.parse_args()

    DBusGMainLoop(set_as_default=True)
    try:
        bus = dbus.SessionBus()
    except Exception as e:
        print(f"[claude-guard-tray] Falha ao conectar ao D-Bus de sessão: {e}", file=sys.stderr)
        sys.exit(1)

    loop = GLib.MainLoop()

    def on_quit():
        print("[claude-guard-tray] Encerrando indicador da bandeja...")
        if args.parent_pid:
            try:
                os.kill(args.parent_pid, signal.SIGTERM)
            except Exception:
                pass
        loop.quit()

    pid = os.getpid()
    service_name = f'org.kde.StatusNotifierItem-claude-guard-{pid}'

    try:
        bus_name = dbus.service.BusName(service_name, bus)
        menu = DBusMenu(bus_name, args.port, on_quit)
        sni = StatusNotifierItem(bus_name, args.port, on_quit)

        watcher = bus.get_object('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher')
        watcher.RegisterStatusNotifierItem(service_name, dbus_interface='org.kde.StatusNotifierWatcher')
        print(f"[claude-guard-tray] Indicador registrado com sucesso na porta {args.port}!")
    except Exception as e:
        print(f"[claude-guard-tray] Aviso: Não foi possível registrar o StatusNotifierItem: {e}", file=sys.stderr)
        sys.exit(1)

    def handle_signal(sig, frame):
        on_quit()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        loop.run()
    except KeyboardInterrupt:
        pass

if __name__ == '__main__':
    main()
