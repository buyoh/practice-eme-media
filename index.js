// ----------------------------------------------------------------------------
// Util
// ----------------------------------------------------------------------------

function hexToUint8Array(hexString) {
  const length = hexString.length / 2;
  const uint8Array = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const byte = parseInt(hexString.substr(i * 2, 2), 16);
    uint8Array[i] = byte;
  }
  return uint8Array;
}

function toBase64Url(u8arr) {
  // btoa を使うと Base64 になってしまい、Base64URL でない
  // 適切に置換する
  return btoa(String.fromCharCode.apply(null, u8arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=*$/, '');
}

// ----------------------------------------------------------------------------
// MSE
// ----------------------------------------------------------------------------

// fragmented mp4 を MSE で読み込む。
function setMediaSourceConcatenated(video, assetURL, mimeCodec) {
  if (!MediaSource.isTypeSupported(mimeCodec)) {
    console.error('Unsupported MIME type or codec: ', mimeCodec);
    return;
  }
  const mediaSource = new MediaSource();
  video.src = URL.createObjectURL(mediaSource);
  mediaSource.addEventListener('sourceopen', async () => {
    const sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);

    const res = await fetch(assetURL);
    const arrayBuffer = await res.arrayBuffer();

    sourceBuffer.addEventListener('updateend', () => {
      // mediaSource.endOfStream();
      video.play();
      console.log(mediaSource.readyState); // ended
    });
    sourceBuffer.appendBuffer(arrayBuffer);
  });
}

/**
 * 
 * @param {*} video 
 * @param {[{urls: Array<String>, mimeCodec: String}]} assets 
 * @returns 
 */
function setMediaSource(video, assets) {
  for (const asset of assets) {
    if (!MediaSource.isTypeSupported(asset.mimeCodec)) {
      console.error('Unsupported MIME type or codec: ', asset.mimeCodec);
      return;
    }
  }
  const mediaSource = new MediaSource();
  video.src = URL.createObjectURL(mediaSource);
  mediaSource.addEventListener('sourceopen', () => {
    for (const asset of assets) {
      const sourceBuffer = mediaSource.addSourceBuffer(asset.mimeCodec);
      let arrayBuffersQueue = null;
      (async () => {
        // Fetch all media files.
        const ress = await Promise.all(asset.urls.map(url => fetch(url)));
        for (const res of ress) {
          res.arrayBuffer().then(ab => {
            // sourceBufferには1つずつarrayBufferをappendしていく。
            // appendの完了はupdateendで受け取る。
            if (arrayBuffersQueue === null) {
              sourceBuffer.appendBuffer(ab);
              arrayBuffersQueue = [];
            } else {
              arrayBuffersQueue.push(ab);
            }
          })
        }
      })();
      sourceBuffer.addEventListener('updateend', () => {
        video.play();
        if (arrayBuffersQueue !== null && arrayBuffersQueue.length >= 1) {
          const ab = arrayBuffersQueue.shift();
          sourceBuffer.appendBuffer(ab);
        }
      });
    }
  });
}

// ----------------------------------------------------------------------------
// EME (org.w3.clearkey)
// ----------------------------------------------------------------------------

async function createMediaKeysClearKey(videoContentType, audioContentType) {
  const config = [
    {
      initDataTypes: ['cenc'],
      videoCapabilities: [
        {
          contentType: videoContentType,
        },
      ],
      audioCapabilities: [
        {
          contentType: audioContentType,
        },
      ],
    },
  ];

  const keySystemAccess = await navigator.requestMediaKeySystemAccess(
    'org.w3.clearkey',
    config
  );
  const mediaKeys = await keySystemAccess.createMediaKeys();
  return mediaKeys;
}

async function handleLicenseRequestClearKey(session, message, encryption_key) {
  const request = JSON.parse(new TextDecoder().decode(message));
  // console.log('request:', request);
  const response = {
    keys: [
      {
        kty: 'oct',
        alg: 'A128KW',
        use: 'enc',
        kid: request.kids[0], // same as encryption_kid
        k: toBase64Url(encryption_key),
      },
    ],
  };
  // console.log('response', response);
  const responseRaw = new TextEncoder().encode(JSON.stringify(response));

  session.update(responseRaw).catch((e) => console.error(e));
}

function setMediaKeysClearKey(video, videoCodec, audioCodec, encryption_key) {
  (async () => {
    try {
      // MediaKey を作成して video にセットする
      const mediaKeys = await createMediaKeysClearKey(
        `video/mp4; codecs="${videoCodec}"`,
        `audio/mp4; codecs="${audioCodec}"`
      );
      await video.setMediaKeys(mediaKeys);
    } catch (error) {
      console.error('EME setup failed:', error);
    }
  })();

  // 暗号化されたメディアを検知したら呼び出される
  video.addEventListener('encrypted', async (event) => {
    try {
      const { initDataType, initData } = event;
      // console.log(
      //   'onencrypted:',
      //   'initDataType=',
      //   initDataType,
      //   'initData=',
      //   initData
      // );
      const mediaKeys = video.mediaKeys;

      // セッションを作成
      const session = mediaKeys.createSession();
      session.addEventListener('message', (event) => {
        // License Request
        const session = event.target;
        const message = event.message;
        handleLicenseRequestClearKey(session, message, encryption_key);
      });
      await session.generateRequest(initDataType, initData);
    } catch (error) {
      console.error('EME setup failed:', error);
    }
  });
}

// ----------------------------------------------------------------------------
// EME (com.widevine.alpha)
// ----------------------------------------------------------------------------

async function createMediaKeysWidevine(videoContentType, audioContentType) {
  const config = [
    {
      initDataTypes: ['cenc'],
      distinctiveIdentifier: "optional",
      persistentState: "required",
      videoCapabilities: [
        {
          contentType: videoContentType,
        },
      ],
      audioCapabilities: [
        {
          contentType: audioContentType,
        },
      ],
    },
  ];

  const keySystemAccess = await navigator.requestMediaKeySystemAccess(
    'com.widevine.alpha',
    config
  );
  const mediaKeys = await keySystemAccess.createMediaKeys();
  return mediaKeys;
}

async function handleLicenseRequestWidevine(session, message, licenseServerInfo) {
  const headers = new Headers();
  for (const key in licenseServerInfo.httpRequestHeaders) {
    headers.append(key, licenseServerInfo.httpRequestHeaders[key]);
  }
  const response = await fetch(licenseServerInfo.serverURL, { headers, method: 'POST' });
  const buffer = await response.arrayBuffer();

  session.update(buffer).catch((e) => console.error(e));
}

function setMediaKeysWidevine(video, videoCodec, audioCodec, licenseServerInfo) {
  (async () => {
    try {
      // MediaKey を作成して video にセットする
      const mediaKeys = await createMediaKeysWidevine(
        `video/mp4; codecs="${videoCodec}"`,
        `audio/mp4; codecs="${audioCodec}"`
      );
      await video.setMediaKeys(mediaKeys);
    } catch (error) {
      console.error('EME setup failed:', error);
    }
  })();

  // 暗号化されたメディアを検知したら呼び出される
  video.addEventListener('encrypted', async (event) => {
    try {
      const { initDataType, initData } = event;
      console.log(
        'onencrypted:',
        'initDataType=',
        initDataType,
        'initData=',
        initData
      );
      const mediaKeys = video.mediaKeys;

      // セッションを作成
      const session = mediaKeys.createSession();
      session.addEventListener('message', (event) => {
        // License Request
        const session = event.target;
        const message = event.message;
        handleLicenseRequestWidevine(session, message, licenseServerInfo);
      });
      await session.generateRequest(initDataType, initData);
    } catch (error) {
      console.error('EME setup failed:', error);
    }
  });
}