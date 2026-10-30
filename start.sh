#!/bin/zsh
# Start the bot and keep the Mac awake while it runs.
# Logs: data/bot.log
cd "$(dirname "$0")" || exit 1
mkdir -p data

# launchd starts with a minimal PATH; find nvm/homebrew node installations.
NVM_BIN=""
if [ -d "$HOME/.nvm/versions/node" ]; then
  NVM_BIN="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" | sort -V | tail -1)/bin"
fi
export PATH="$NVM_BIN:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

exec caffeinate -i npm start >> data/bot.log 2>&1
