#!/bin/bash
# InfraMonitor - Leichter Heartbeat Check
# Läuft per cron, meldet nur bei Problemen

# Config
WEBHOOK_URL="https://forms.proxy.peppermint-digital.com/webhook/inframonitor"
WEBHOOK_TOKEN="50fb1232cd94562c12fb6c3f317de7623c6460ecbb67a376"
SSH_KEY="/home/codingmachine/.ssh/infra-monitor"

# Thresholds
DISK_WARN=80
DISK_CRIT=90
MEMORY_WARN=85
LOAD_WARN=4

alerts=""
add_alert() { alerts="${alerts}🚨 $1\n"; }

# === LOCAL CHECKS (omarchy) ===
check_local() {
    local host="omarchy"
    
    # Disk
    disk=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
    [ "$disk" -ge "$DISK_CRIT" ] && add_alert "$host: Disk ${disk}% CRITICAL"
    [ "$disk" -ge "$DISK_WARN" ] && [ "$disk" -lt "$DISK_CRIT" ] && add_alert "$host: Disk ${disk}%"
    
    # Memory
    mem_total=$(free | grep Mem | awk '{print $2}')
    mem_used=$(free | grep Mem | awk '{print $3}')
    mem_pct=$((mem_used * 100 / mem_total))
    [ "$mem_pct" -ge "$MEMORY_WARN" ] && add_alert "$host: Memory ${mem_pct}%"
    
    # Load
    load=$(awk '{print int($1)}' /proc/loadavg)
    [ "$load" -ge "$LOAD_WARN" ] && add_alert "$host: Load $load"
    
    # Services
    for svc in ai-brain docker; do
        systemctl is-active --quiet "$svc" 2>/dev/null || add_alert "$host: $svc DOWN"
    done
    for svc in nanoclaw clawdbot-gateway; do
        systemctl --user -M codingmachine@ is-active --quiet "$svc" 2>/dev/null || add_alert "$host: $svc DOWN"
    done
}

# === SSH CHECKS ===
check_ssh() {
    local name=$1 host=$2 user=$3 check_nginx=${4:-true}

    # Single SSH connection: test + checks combined
    result=$(ssh -i "$SSH_KEY" -o ConnectTimeout=10 -o BatchMode=yes "$user@$host" '
        disk=$(df / | tail -1 | awk "{print \$5}" | tr -d "%")
        mem_total=$(free | grep Mem | awk "{print \$2}")
        mem_used=$(free | grep Mem | awk "{print \$3}")
        mem_pct=$((mem_used * 100 / mem_total))
        load=$(awk "{print int(\$1)}" /proc/loadavg)
        nginx=$(systemctl is-active nginx 2>/dev/null || echo "inactive")
        echo "$disk $mem_pct $load $nginx"
    ' 2>/dev/null)

    if [ -z "$result" ]; then
        add_alert "$name: SSH UNREACHABLE"
        return
    fi

    read disk mem load nginx <<< "$result"

    [ "${disk:-0}" -ge "$DISK_CRIT" ] && add_alert "$name: Disk ${disk}% CRITICAL"
    [ "${disk:-0}" -ge "$DISK_WARN" ] && [ "${disk:-0}" -lt "$DISK_CRIT" ] && add_alert "$name: Disk ${disk}%"
    [ "${mem:-0}" -ge "$MEMORY_WARN" ] && add_alert "$name: Memory ${mem}%"
    [ "${load:-0}" -ge "$LOAD_WARN" ] && add_alert "$name: Load $load"
    # Only check nginx if requested (4th param)
    [ "$check_nginx" = "true" ] && [ "$nginx" != "active" ] && add_alert "$name: nginx DOWN"
}

# === PING CHECK (for hosts without SSH access) ===
check_ping() {
    local name=$1 host=$2
    
    if ! ping -c 2 -W 3 "$host" > /dev/null 2>&1; then
        add_alert "$name: UNREACHABLE"
    fi
}

# === BACKUP CHECK (omarchy) ===
check_backup() {
    local host="omarchy"
    local backup_env="/home/codingmachine/clawd/backup/backup.env"
    local max_age_hours=48
    
    # Check if backup.env exists
    if [ ! -f "$backup_env" ]; then
        add_alert "$host: Backup not configured"
        return
    fi
    
    # Load restic env
    source "$backup_env"
    
    # Get latest snapshot timestamp (with timeout)
    latest=$(timeout 30 restic snapshots --json 2>/dev/null | jq -r '.[-1].time // empty' 2>/dev/null)
    
    if [ -z "$latest" ]; then
        add_alert "$host: No backup snapshots found"
        return
    fi
    
    # Calculate age in hours
    latest_epoch=$(date -d "$latest" +%s 2>/dev/null || echo 0)
    now_epoch=$(date +%s)
    age_hours=$(( (now_epoch - latest_epoch) / 3600 ))
    
    if [ "$age_hours" -gt "$max_age_hours" ]; then
        add_alert "$host: Backup ${age_hours}h old (max ${max_age_hours}h)"
    fi
}

# === RUN CHECKS ===
check_local
check_backup
check_ssh "bold-tokyo" "178.104.23.247" "forge" true
check_ssh "coolify-instanz" "188.245.53.38" "root" false  # Coolify uses own proxy, no nginx
check_ssh "kiserver" "192.168.1.147" "bastian" false  # No nginx on kiserver

# === REPORT ===
if [ -n "$alerts" ]; then
    clean_alerts=$(echo -e "$alerts" | tr '\n' ' ' | sed 's/"/\\"/g')
    curl -s -X POST "$WEBHOOK_URL" \
        -H "Authorization: Bearer $WEBHOOK_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"type\": \"infra-alert\", \"alerts\": \"$clean_alerts\"}" \
        > /dev/null 2>&1 || true
    echo "[$(date)] Alerts: $clean_alerts"
else
    [ "${DEBUG:-}" = "1" ] && echo "[$(date)] All OK"
fi

# === WEBSITE CHECKS ===
check_website() {
    local name=$1 url=$2
    
    # HTTP Status
    status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
    if [ "$status" != "200" ] && [ "$status" != "301" ] && [ "$status" != "302" ]; then
        add_alert "$name: HTTP $status"
    fi
    
    # SSL Expiry (warn 14 days)
    if [[ "$url" == https://* ]]; then
        domain=$(echo "$url" | sed 's|https://||' | cut -d/ -f1)
        expiry=$(echo | openssl s_client -servername "$domain" -connect "$domain:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
        if [ -n "$expiry" ]; then
            expiry_epoch=$(date -d "$expiry" +%s 2>/dev/null || echo 0)
            now_epoch=$(date +%s)
            days_left=$(( (expiry_epoch - now_epoch) / 86400 ))
            [ "$days_left" -lt 14 ] && [ "$days_left" -ge 0 ] && add_alert "$name: SSL expires in ${days_left} days"
            [ "$days_left" -lt 0 ] && add_alert "$name: SSL EXPIRED"
        fi
    fi
}

# Websites
check_website "schuelerferienpass.de" "https://schülerferienpass.de"
check_website "peppermint-digital.de" "https://peppermint-digital.de/"
check_website "crewtex.de" "https://crewtex.de/"
