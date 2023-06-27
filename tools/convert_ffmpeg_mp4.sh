#!/bin/bash

ffmpeg -i tears_of_steel_1080p_trim.mp4 -c copy \
  -encryption_scheme cenc-aes-ctr \
  -encryption_key 9c61173d2db8939009be4bd689533ade \
  -encryption_kid a53fcebc83532682766c7d0e012fe92f \
  output_encrypted.mp4