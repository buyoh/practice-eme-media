#!/bin/bash

cd $(dirname $0)
cd docs

python3 -m http.server 8080
# npx http-server
