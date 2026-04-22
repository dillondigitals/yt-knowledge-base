#!/bin/bash
cd "$(dirname "$0")"
echo "Starting Knowledge Base Builder..."
echo "Opening http://localhost:3000 in 5 seconds..."
npm run dev &
sleep 5
open http://localhost:3000
wait
