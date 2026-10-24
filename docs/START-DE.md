# Entwickler-Alpha: Kurzstart

Die Workbench ist eine anpassbare Grundlage für technisch betreute Unternehmen. Sie ist kein fertiger Dienst, bei dem ein Klick auf Gmail für die gesamte Einrichtung genügt.

1. Windows 11 x64 und Node 24.x mit npm verwenden.
2. Im Quellordner `npm ci`, `node node_modules/electron/install.js`, dann `npm run verify` und `npm run test:desktop` ausführen. Diese Prüfungen brauchen keine echten Konten und verursachen keine API-Kosten.
3. Architektur und Anpassungsanleitung lesen. Mit Work zunächst eine kleine Änderung anhand fiktiver Daten durchführen und prüfen.
4. Für echte Nutzung eigene Google-Desktop-OAuth-Konfiguration, Gmail-Konto, vollständige Signatur und eigene Modellzugänge einrichten. API-Anbieter können Nutzung berechnen.
5. Zuerst wenige eigene Testkontakte, einen überprüften Entwurf und eine bewusst bestätigte Testsendung verwenden. Versand und Antwort tatsächlich kontrollieren.

[Einrichtung](SETUP.md) · [Build](BUILD.md) · [Architektur](ARCHITECTURE.md) · [Mit Work anpassen](ADAPTING-WITH-WORK.md) · [Grenzen](LIMITATIONS.md)

MIT erlaubt auch interne und kommerzielle Anpassungen. Lizenz- und Urhebervermerke sowie die Hinweise zu Abhängigkeiten bleiben erhalten. Bei einer Firmenversion erst den eigenen Datenordner prüfen; eine bloße Umbenennung der App isoliert vorhandene Daten nicht automatisch.
