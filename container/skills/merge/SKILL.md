---
name: merge
description: Feature-Branch mergen, dokumentieren und aufräumen
---

# /merge - Branch Merge Routine

Wenn dieser Skill aufgerufen wird, führe folgende Schritte aus:

## 1. Session im AI Brain dokumentieren

Falls noch nicht geschehen (prüfe mit `get-context-tool`):
- Nutze `mcp__ai-brain__add-memory-tool` um eine Session-Note zu erstellen
- Ermittle das Projekt anhand des Arbeitsverzeichnisses
- Dokumentiere alle Änderungen der Session

## 2. Aufgaben checken

- Offene Tasks im AI Brain prüfen: `mcp__ai-brain__list-tasks-tool`
- Erledigte Tasks abhaken: `mcp__ai-brain__complete-task-tool`
- Verifizieren dass alle geplanten Änderungen umgesetzt wurden

## 3. Uncommitted Changes committen

Falls uncommitted Changes vorhanden:
- `git add -A`
- Commit mit aussagekräftiger Message erstellen
- Am Ende hinzufügen: `Co-Authored-By: Claude <noreply@anthropic.com>`

## 4. Branch mergen

- Aktuellen Branch Namen ermitteln
- Falls bereits auf main: Nur committen, kein Merge nötig
- Sonst: Auf main wechseln, pull, Feature-Branch mergen
- Bei Konflikten: User informieren und abbrechen

## 5. Feature-Branch löschen

- Lokalen Feature-Branch löschen: `git branch -d <feature-branch>`
- Remote Feature-Branch löschen: `git push origin --delete <feature-branch>`

---

**Hinweis:** Dieser Skill pusht NICHT. Nach dem Merge kannst du mit `/fertig` commiten und pushen falls nötig.
