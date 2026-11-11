#!/usr/bin/env bash
# Times one Claude Code hook run and logs it for Morpheus, then exits exactly as the hook did.
#
#   "command": "bash \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/morpheus-time.sh bash \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/guard.sh"
#
# `morpheus init` writes these for you. The hook gets the same stdin; its stdout, stderr and exit
# code pass through untouched. One JSON line per run goes to <git dir>/morpheus/runs.jsonl
# (outside git: .claude/morpheus/runs.jsonl): when, which script, how long, the exit code, and the
# event, tool, tool call and session from the hook's input. Nothing else is recorded. If logging
# fails, the hook's result still stands.

input=$(cat)
now_ms() { perl -MTime::HiRes=time -e 'printf "%.0f", time*1000' 2>/dev/null || echo $(($(date +%s) * 1000)); }
t0=$(now_ms)
printf '%s' "$input" | "$@"
code=$?
t1=$(now_ms)

{
  root=${CLAUDE_PROJECT_DIR:-$PWD}
  common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  dir=${MORPHEUS_LOG_DIR:-${common:+$common/morpheus}}
  dir=${dir:-$root/.claude/morpheus}
  mkdir -p "$dir"
  script=""
  for a in "$@"; do
    case "$a" in *.sh | *.py | *.js | *.mjs | *.cjs | *.ts | *.rb) script=${a##*/} && script=${script%.*} && break ;; esac
  done
  [ -n "$script" ] || script=${1##*/}
  MORPHEUS_INPUT=$input MORPHEUS_SCRIPT=$script MORPHEUS_MS=$((t1 - t0)) MORPHEUS_EXIT=$code MORPHEUS_T1=$t1 \
    perl -MJSON::PP -MPOSIX=strftime -e '
      my $in = eval { JSON::PP->new->decode($ENV{MORPHEUS_INPUT}) } || {};
      my $t = $ENV{MORPHEUS_T1};
      my $ts = strftime("%Y-%m-%dT%H:%M:%S", gmtime(int($t / 1000))) . sprintf(".%03dZ", $t % 1000);
      my %r = (ts => $ts, script => $ENV{MORPHEUS_SCRIPT}, ms => $ENV{MORPHEUS_MS} + 0,
               exit => $ENV{MORPHEUS_EXIT} + 0, event => $in->{hook_event_name},
               tool => $in->{tool_name}, tool_use_id => $in->{tool_use_id}, session => $in->{session_id});
      delete $r{$_} for grep { !defined $r{$_} } keys %r;
      print JSON::PP->new->canonical->encode(\%r), "\n";
    ' >>"$dir/runs.jsonl"
} 2>/dev/null || true

exit "$code"
