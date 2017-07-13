// @flow

import compression from 'compression'
import express from 'express'
import path from 'path'
import fs from 'fs'
import request from 'request'
import dotenv from 'dotenv'
import schedule from 'node-schedule'
import { execSync } from 'child_process'

import { Server } from 'http'

import { WEB_PORT, STATIC_PATH } from '../shared/config'
import { isProd } from '../shared/util'

// Bake matroid in for now
let accessTokenExpiration
let accessToken

dotenv.config()

const app = express()
// flow-disable-next-line
const http = Server(app)

// Slack files
const webhooksFile = path.join(__dirname, '../../webhooks.txt')
const payloadsFile = path.join(__dirname, '../../payloads.txt')

app.use(compression())
app.use(STATIC_PATH, express.static('public'))

app.get('/auth', (req, res) => {
  res.sendFile(path.join(__dirname, '/pages/add_to_slack.html'))
})

app.get('/auth/redirect', (req, res) => {
  const options = {
    uri: `https://slack.com/api/oauth.access?code=${req.query.code}&client_id=${process.env.SLACK_CLIENT_ID}&client_secret=${process.env.SLACK_CLIENT_SECRET}&redirect_uri=${process.env.SLACK_REDIRECT_URI}`,
    method: 'GET',
  }
  request(options, (error, response, body) => {
    const JSONresponse = JSON.parse(body)
    if (!JSONresponse.ok) {
      // eslint-disable-next-line no-console
      res.send(`Error encountered: \n${JSON.stringify(JSONresponse)}`).status(200).end()
    } else {
      // eslint-disable-next-line no-console
      fs.appendFileSync(webhooksFile, `${JSONresponse.incoming_webhook.url}\n\r`)
      fs.appendFileSync(payloadsFile, `${body}\n\r`)
      res.send('Success!')
    }
  })
})

function getPrograms(callback) {
  // Get a list of programs from the archive
  const options = {
    uri: 'https://archive.org/details/tv?weekshows&output=json',
    method: 'GET',
  }

  request(options, (error, response, body) => {
    const JSONresponse = JSON.parse(body)
    callback(JSONresponse)
  })
}

function parseProgramId(programId) {
  const parts = programId.split('_')
  const network = parts.shift()
  const date = parts.shift()
  const year = date.slice(0, 4)
  const month = date.slice(4, 6)
  const day = date.slice(6, 8)
  const time = parts.shift()
  const hour = time.slice(0, 2)
  const minute = time.slice(2, 4)
  const second = time.slice(4, 6)
  const program = parts.join('_')
  const datetime = new Date(`${year}-${month}-${day} ${hour}:${minute}:${second} UTC`)

  return {
    id: programId,
    network,
    airtime: datetime,
    program,
  }
}

function getPaths(programId) {
  return {
    unprocessedPath: path.join(__dirname, `../../programs/_${programId}.json`),
    processingPath: path.join(__dirname, `../../programs/~${programId}.json`),
    processedPath: path.join(__dirname, `../../programs/${programId}.json`),
    videoPath: path.join(__dirname, `../../videos/${programId}.mp4`),
    ffmpegOutputPath: path.join(__dirname, `../../videos/${programId}_ffmpeg.out`),
    matroidOutputPath: path.join(__dirname, `../../results/${programId}.json`),
    processedOutputPath: path.join(__dirname, `../../results/${programId}_processed.json`),
  }
}

function isRegistered(programId) {
  const paths = getPaths(programId)
  if (fs.existsSync(paths.unprocessedPath)
  || fs.existsSync(paths.processingPath)
  || fs.existsSync(paths.processedPath)) {
    return true
  }

  return false
}

function filterPrograms(programList) {
  // Cut out programs that:
  // 1) didn't happen in the past 24h
  // 2) Aren't on one of the channels we track
  // 3) have already been downloaded

  const filteredList = []
  for (let i = 0; i < programList.length; i += 1) {
    const programId = programList[i]
    const program = parseProgramId(programId)
    const now = new Date()

    if ((Math.abs(now.getTime() - program.airtime.getTime()) <= 86400000)
     && (program.network === 'CNNW'
      || program.network === 'FOXNEWSW'
      || program.network === 'MSNBCW'
      || program.network === 'BBCNEWS')
     && (!isRegistered(programId))) {
      filteredList.push(program)
    }
  }
  return filteredList
}

function registerPrograms(programList) {
  for (let i = 0; i < programList.length; i += 1) {
    const program = programList[i]
    const paths = getPaths(program.id)
    fs.writeFileSync(paths.unprocessedPath, JSON.stringify(program))
  }
}

function downloadProgram(program, callback) {
  const paths = getPaths(program.id)
  const file = fs.createWriteStream(paths.videoPath)

  const options = {
    uri: `http://archive.org/download/${program.id}/${program.id}.mp4`,
    method: 'GET',
    headers: {
      Cookie: `logged-in-user=${process.env.ARCHIVE_USER_ID};logged-in-sig=${process.env.ARCHIVE_SIG}`,
    },
  }

  const stream = request(options).pipe(file)
  stream.on('finish', () => {
    callback(true)
  })
}

function splitProgram(program) {
  const paths = getPaths(program.id)
  const cmd = `${process.env.FFMPEG_PATH} -i "${paths.videoPath}" -acodec copy -f segment -segment_time 1200 -vcodec copy -reset_timestamps 1 -map 0 -segment_list ${paths.ffmpegOutputPath} ${paths.videoPath}_OUTPUT%d.mp4`
  execSync(cmd, {
    stdio: 'ignore',
  })
  const output = fs.readFileSync(paths.ffmpegOutputPath, 'utf8')
  const pieces = output.split('\n')
  const files = []
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i]
    if (piece.trim() !== '') {
      files.push(path.join(__dirname, `../../videos/${piece}`))
    }
  }
  return files
}

function getDuration(videoPath) {
  const cmd = `${process.env.FFPROBE_PATH} -i "${videoPath}" -show_entries format=duration -v quiet -of csv="p=0"`
  const output = execSync(cmd, {
    encoding: 'utf8',
  })
  return output.trim()
}

function getAccessToken(callback) {
  if (Date() < accessTokenExpiration) {
    callback(accessToken)
    return
  }

  const options = {
    uri: 'https://www.matroid.com/api/0.1/oauth/token',
    method: 'POST',
    form: {
      client_id: process.env.MATROID_CLIENT_ID,
      client_secret: process.env.MATROID_CLIENT_SECRET,
      grant_type: 'client_credentials',
    },
  }

  request(options, (error, response, body) => {
    const JSONresponse = JSON.parse(body)
    if (JSONresponse.access_token) {
      // eslint-disable-next-line no-console
      accessToken = JSONresponse.access_token
      accessTokenExpiration = Date() + (JSONresponse.expires_in - 1000)
      callback(accessToken)
    }
  })
}

function startMatroidProcessing(videoPath, callback) {
  getAccessToken((token) => {
    const options = {
      uri: `https://www.matroid.com/api/0.1/detectors/${process.env.MATROID_DETECTOR_ID}/classify_video`,
      method: 'POST',
      formData: {
        file: fs.createReadStream(videoPath),
      },
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
    request(options, (error, response, body) => {
      const JSONresponse = JSON.parse(body)
      if (JSONresponse.video_id) {
        callback(JSONresponse.video_id)
      }
    })
  })
}

function getMatroidResults(matroidVideoId, callback) {
  getAccessToken((token) => {
    const options = {
      uri: `https://www.matroid.com/api/0.1/videos/${matroidVideoId}`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }

    request(options, (error, response, body) => {
      const JSONresponse = JSON.parse(body)
      if (JSONresponse.classification_progress === undefined) {
        return
      }

      if (JSONresponse.classification_progress !== 100) {
        console.log(`    PROCESSING: ${JSONresponse.classification_progress} :: ${matroidVideoId}`)

        setTimeout(() => {
          getMatroidResults(matroidVideoId, callback)
        }, 10000)
      } else {
        callback(JSONresponse)
      }
    })
  })
}

// Function to push a program to Matroid
function runMatroid(videoPath, index, callback) {
  startMatroidProcessing(videoPath, (matroidVideoId) => {
    getMatroidResults(matroidVideoId, (results) => {
      // Clean up the video slice
      fs.unlink(videoPath)

      // Package the results
      const finalResults = {
        duration: getDuration(videoPath),
        results,
      }
      callback(finalResults, index)
    })
  })
}

function storeResults(fullResults, program) {
  // Write a file saving the results for future
  const paths = getPaths(program.id)
  fs.writeFileSync(paths.matroidOutputPath, JSON.stringify(fullResults))
}

function secondsToTime(seconds) {
  const s = seconds % 60
  const m = Math.floor((seconds % 3600) / 60)
  const h = Math.floor((seconds % 86400) / 3600)
  return `${h}:${m}:${s}`
}

function loadSlackWebhooks() {
  const webhooks = fs.readFileSync(webhooksFile, 'utf8')
  return webhooks.split('\n')
}

function announceResults(fullResults, program) {
  // Generate the results and send them to all the slack buddies
  console.log(`  RESULTS: ${program.id}`)

  const paths = getPaths(program.id)

  let cursor = 0
  const processedResults = {}

  // Loop through each segment
  for (let i = 0; i < fullResults.length; i += 1) {
    const fullResult = fullResults[i]
    const segment = fullResult.results
    const duration = fullResult.duration
    const labels = segment.label_dict
    const detections = segment.detections

    // Create empty buckets for all labels
    for (let j = 0; j < labels; j += 1) {
      const label = labels[j]
      if (processedResults[label] === undefined) {
        processedResults[label] = []
      }
    }

    // Loop through each second
    const detectedSeconds = Object.keys(detections)
    for (let j = 0; j < detectedSeconds.length; j += 1) {
      let second = detectedSeconds[j]
      const detection = detections[second]
      second += cursor

      // Loop through each face result
      const detectedLabelIds = Object.keys(detection)
      for (let k = 0; k < detectedLabelIds.length; k += 1) {
        const labelId = detectedLabelIds[k]
        const frame = detection[labelId]
        const label = labels[labelId]
        let maxScore = 0

        for (let l = 0; l < frame.length; l += 1) {
          const face = frame[l]
          maxScore = Math.max(maxScore, face.score)
        }

        // Make sure this label has a bucket for results
        if (processedResults[label] === undefined) {
          processedResults[label] = []
        }

        // Only count hits with more than 90% confidence
        if (maxScore > 90) {
          processedResults[label][second] = maxScore
        }
      }
      cursor += duration
    }
  }

  // Store the processed results for debugging
  fs.writeFileSync(paths.processedOutputPath, JSON.stringify(processedResults))

  let finalString = ''
  finalString += '======================'
  finalString += `\n<https://archive.org/details/${program.id}|${program.network},${program.program},${program.airtime}>`

  const processedLabels = Object.keys(processedResults)
  for (let i = 0; i < fullResults.length; i += 1) {
    const label = processedLabels[i]
    const results = processedResults[label]
    if (results.length === 0) {
      finalString += `\n:no_entry_sign: \`${label}\` Not Found`
    } else {
      finalString += `\n:white_check_mark: \`${label}\` Detected`

      let start = -1
      let end = -1

      const seconds = Object.keys(results)
      for (let j = 0; j < seconds.length; j += 1) {
        const second = seconds[j]
        if (start === -1) {
          start = second
          end = second
        }

        // Allow gaps of up to 3 seconds
        if (second - end <= 3) {
          end = second
        } else {
          finalString += `\n * ${secondsToTime(start)} - ${secondsToTime(end)} <https://archive.org/details/${program.id}#start/${start}/end/${end}|(${end - start}s)>`
          start = second
          end = second
        }
      }
      if (start !== -1) {
        finalString += `\n * ${secondsToTime(start)} - ${secondsToTime(end)} <https://archive.org/details/${program.id}#start/${start}/end/${end}|(${end - start}s)>`
      }
    }
  }

  const slackWebhooks = loadSlackWebhooks()
  for (let i = 0; i < slackWebhooks.length; i += 1) {
    const webhook = slackWebhooks[i]
    if (webhook.trim() !== '') {
      const options = {
        uri: webhook,
        method: 'POST',
        headers: {
          'Content-type': 'application/json',
        },
        json: {
          text: finalString,
        },
      }
      request(options)
    }
  }
}

function processProgram(program) {
  const paths = getPaths(program.id)

  // Mark the program as processing
  fs.renameSync(paths.unprocessedPath, paths.processingPath)

  console.log(`  Downloading ${program.id}`)
  downloadProgram(program, (success) => {
    if (!success) {
      // This didn't work, retry it in 10 minutes
      console.log(`  ERROR: Couldn't download video :: ${program.id}`)
      setTimeout(() => {
        fs.renameSync(paths.processingPath, paths.unprocessedPath)
      }, 600000)
      return
    }
    console.log(`  DOWNLOADED: Video downloaded :: ${program.id}`)
    const videos = splitProgram(program)
    const fullResults = []
    let counter = videos.length
    console.log(`  SPLIT: (${videos.length} total) :: ${program.id}`)
    const watchResults = (results, index) => {
      fullResults[index] = results
      counter -= 1
      console.log(`  PROCESSED: Index ${index} (${counter} remaining) :: ${program.id}`)
      if (counter === 0) {
        // All done
        storeResults(fullResults, program)
        announceResults(fullResults, program)
        fs.renameSync(paths.processingPath, paths.processedPath)
      }
    }
    for (let i = 0; i < videos.length; i += 1) {
      const video = videos[i]
      runMatroid(video, i, watchResults)
    }

    // Clean up the video file
    fs.unlink(paths.videoPath)
  })
}

function getUnprocessedProgramIds() {
  const files = fs.readdirSync(path.join(__dirname, '../../programs/'))
  const unprocessedPrograms = []
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    if (file.slice(0, 1) === '_') {
      unprocessedPrograms.push(file.slice(1, -5))
    }
  }
  return unprocessedPrograms
}

// Set up scheduled download of program IDs
schedule.scheduleJob('* * * * *', () => {
  getPrograms((programIds) => {
    const programList = filterPrograms(programIds)
    registerPrograms(programList)
  })
})

// Set up scheduled processing of programs
schedule.scheduleJob('* * * * *', () => {
  console.log('Checking for unprocessed programs...')
  const programIds = getUnprocessedProgramIds()
  for (let i = 0; i < programIds.length; i += 1) {
    const programId = programIds[i]
    const paths = getPaths(programId)
    console.log(`Processing ${programId}`)
    fs.readFile(paths.unprocessedPath, (err, data) => {
      const program = JSON.parse(data)
      processProgram(program)
    })
  }
})

http.listen(WEB_PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on port ${WEB_PORT} ${isProd ? '(production)' :
    '(development).\nKeep "yarn dev:wds" running in an other terminal'}.`)
})
