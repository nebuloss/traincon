#!/bin/sh
# Heap and descriptor curve for the running server.
#
# Installed on the server host as /usr/local/bin/traincon-mem and run from
# cron every two minutes:
#
#   */2 * * * * /usr/local/bin/traincon-mem
#
# It lives here as well as there because living only there is how it broke:
# the port from Node changed the process it looks for, nothing in this
# repository mentioned it, and it went on logging a plausible-looking zero for
# weeks. A diagnostic that watches this server belongs beside it.
#
# One line every couple of minutes: what the heap holds, and how many
# descriptors are open. The process has died on the heap ceiling on five
# separate days and every diagnosis so far has been a single reading; a curve
# says which retained structure tracks the growth, or that none of them does.
S=$(wget -qO- http://127.0.0.1:3000/api/stats 2>/dev/null) || exit 0

# Finding the server is fiddlier than it looks, and three obvious ways are all
# wrong on this box:
#
#   pgrep node        what this said until well after the port, by which time
#                     it matched nothing at all
#   pgrep -f <path>   matches any process whose arguments merely mention the
#                     path — a shell running a command about it, an editor —
#                     and would report that process's descriptors as the
#                     server's
#   pgrep traincon    matches this script, which is called traincon-mem; comm
#                     is truncated to fifteen characters, so it arrives as
#                     traincon-mem-pr and looks like a hit
#
# So the name is compared exactly, against /proc/<pid>/comm. The supervisor is
# not a candidate either way: its own name is supervise-daemon.
P=
for p in $(pgrep traincon 2>/dev/null); do
  [ "$(cat /proc/"$p"/comm 2>/dev/null)" = traincon ] || continue
  P=$p
  break
done

# `?` rather than a number when the process is not found. It read fd=0 for
# weeks after the port — indistinguishable from a server holding no
# descriptors, which is why nobody noticed the half of this that most needed
# a curve had stopped producing one.
if [ -n "$P" ]; then
  FD=$(ls /proc/"$P"/fd 2>/dev/null | wc -l)
else
  FD='?'
fi
echo "$(date -u +%FT%TZ) fd=$FD $S" >> /var/log/traincon-mem.log
