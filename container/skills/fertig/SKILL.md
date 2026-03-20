---
name: fertig
description: Abschluss-Routine für Code-Änderungen (Changelog, Commit, Push)
---

# /fertig - Abschluss-Routine

Wenn dieser Skill aufgerufen wird, führe folgende Schritte aus:

## 1. Changelog aktualisieren (wenn vorhanden)

Falls ein Changelog-System existiert (`changelogs/` Ordner oder `CHANGELOG.md`):
- Neue Version erstellen (Patch für Fixes, Minor für Features)
- Changelog-Datei aktualisieren

**Überspringe diesen Schritt wenn kein Changelog existiert.**

## 2. Commit erstellen

- `git add -A`
- Aussagekräftige Commit-Message erstellen
- Am Ende hinzufügen: `Co-Authored-By: Claude <noreply@anthropic.com>`

## 3. Push ausführen

- `git push` nach erfolgreichem Commit

---

**Hinweis:** Dieser Skill ist für den Abschluss von Arbeiten an einem Branch gedacht. Für Dokumentation nutze `/dokumentation`, für Merges nutze `/merge`.
