# WhatAmonth

Simple phoenix month app

## Run for develop
```bash
mix phx.server
```
Server will be runed on http://localhost:4000

## Deploy command sequence
```bash
git commit 
git push
ansible-playbook ansible/pull.yaml -i ansible/inventory.yaml
```