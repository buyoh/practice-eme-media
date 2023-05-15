#!/bin/bash

for name in $(find . -name "*.mp4"); do
  echo "INPUT ${name}"
  mp4info $name | grep Codec
done
