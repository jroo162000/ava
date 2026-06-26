"""
Generate a Piper-ready training corpus by having the ElevenLabs 'Vella' voice
read a set of varied sentences. Because we feed the text, transcripts are exact.

Outputs (LJSpeech format):
  vella_dataset/wavs/vella_0000.wav ...   (24 kHz mono 16-bit; Piper resamples to 22050)
  vella_dataset/metadata.csv              ("id|text" per line)

Key is read from the ELEVENLABS_API_KEY env var (never stored here).
Run:  python gen_vella_corpus.py
Re-runnable: skips clips already generated.
"""
import os, sys, json, time, wave, urllib.request, urllib.error

VOICE_ID = "C87xFko6mfAf2uYY3Rdr"
MODEL = "eleven_flash_v2_5"
OUT_FMT = "pcm_24000"
SR = 24000

API_KEY = os.environ.get("ELEVENLABS_API_KEY", "").strip()
if not API_KEY:
    print("ERROR: ELEVENLABS_API_KEY not set in environment"); sys.exit(1)

BASE = os.path.dirname(os.path.abspath(__file__))
OUTDIR = os.path.join(BASE, "vella_dataset")
WAVS = os.path.join(OUTDIR, "wavs")
os.makedirs(WAVS, exist_ok=True)

SENTENCES = [
    "Hi there, I'm Ava, your personal assistant. How can I help you today?",
    "The quick brown fox jumps over the lazy dog while five clever wizards watch.",
    "Could you remind me to call the dentist tomorrow at nine in the morning?",
    "It looks like the weather will be sunny with a high near seventy two degrees.",
    "I've added three new items to your shopping list: milk, eggs, and fresh bread.",
    "Let me check your calendar and see what meetings you have scheduled for Friday.",
    "Honestly, that's one of the most thoughtful questions anyone has asked me all week.",
    "Please speak a little louder; the room is noisy and I want to hear you clearly.",
    "The package was delivered at four fifteen this afternoon and signed for at the door.",
    "Your flight departs from gate twenty three at six o'clock on Sunday evening.",
    "When you get a moment, would you mind reviewing the report I sent last night?",
    "She sells seashells by the seashore, and the shells she sells are surely seashells.",
    "We measured roughly twelve and a half inches of rain over the past three days.",
    "I'm sorry, I didn't quite catch that. Could you please repeat the last part?",
    "Turning off the living room lights and setting the thermostat to sixty eight degrees.",
    "Imagine a calm beach at sunset, with gentle waves rolling softly onto warm sand.",
    "The museum opens at ten and closes at five, except on Mondays when it stays shut.",
    "Thanks for your patience; I know this has taken a little longer than expected.",
    "A bright blue jay flew across the meadow and landed on the old oak branch.",
    "Remember to drink water, stretch your legs, and take a short break every hour.",
    "The recipe calls for two cups of flour, a pinch of salt, and one large egg.",
    "I found four restaurants nearby that are open now and have great reviews.",
    "Could you spell that name for me, letter by letter, so I get it exactly right?",
    "Our train was delayed by twenty minutes, but we still made the connection in time.",
    "He carefully painted the fence a deep shade of forest green over the weekend.",
    "What an absolutely wonderful idea; let's go ahead and put it on the schedule.",
    "The library has extended its hours and is now open until nine on weeknights.",
    "Take the second left, continue for half a mile, and the office is on your right.",
    "I really appreciate you trusting me with this; I'll do my very best to help.",
    "Seven swans were swimming smoothly across the silver surface of the still lake.",
    "Your battery is at fifteen percent, so you may want to plug in your phone soon.",
    "Let's break this big project into smaller, manageable steps we can finish today.",
    "The children laughed and played in the park until the streetlights flickered on.",
    "I can read your messages aloud, send a quick reply, or save it for later.",
    "Curiously, the answer was hiding in plain sight the entire time we were searching.",
    "Mix the blueberries gently so you don't crush them before folding in the batter.",
    "On Tuesday the team will gather at eleven to discuss the upcoming product launch.",
    "Whisper if you'd like; my microphone is sensitive and can pick up a soft voice.",
    "The old lighthouse stood proudly on the cliff, guiding ships through the fog.",
    "Would you prefer the window seat or the aisle for your trip next Thursday?",
    "I've saved your note titled, remember to water the plants, in your reminders.",
    "Eight hungry travelers shared a warm loaf of bread beside the crackling fire.",
    "That movie starts at seven forty, so we should leave the house around seven.",
    "Just so you know, your subscription renews automatically on the first of the month.",
    "The garden was bursting with roses, tulips, daffodils, and bright yellow marigolds.",
    "Could you double check the address before I send the driver on their way?",
    "A gentle breeze carried the scent of pine through the quiet mountain valley.",
    "I think you'll love this song; it has a smooth rhythm and a catchy chorus.",
    "Forty percent off everything in the store sounds like a deal worth grabbing.",
    "Let me know if you want me to translate that phrase into Spanish or French.",
    "The puzzle had exactly one thousand pieces, and we finished it on a rainy day.",
    "Before bed, I can dim the lights, play soft music, and set your morning alarm.",
    "Three friendly dolphins followed our boat, leaping playfully through the waves.",
    "Your doctor's appointment is confirmed for Wednesday the twelfth at two thirty.",
    "Honestly, learning something new every single day keeps life interesting, doesn't it?",
    "I'll keep an eye on the traffic and warn you if your commute starts to slow down.",
    "The chef garnished each plate with a sprig of mint and a drizzle of olive oil.",
    "We watched the fireworks burst into red, gold, and shimmering green over the bay.",
    "If you ever feel stuck, just ask, and we'll work through the problem together.",
    "Six squirrels scurried up the tree, chasing each other around the thick branches.",
    "Your total comes to forty nine dollars and ninety nine cents, including tax.",
    "The author signed every book with a kind note and a small, careful drawing.",
    "Let's set a timer for twenty five minutes and focus, then take a five minute break.",
    "Across the field, the windmill turned slowly against a wide and cloudless sky.",
    "I noticed you have a free hour tomorrow; would you like me to block it for rest?",
    "The kitten curled up on the soft blanket and fell asleep within a few minutes.",
    "Please confirm whether you'd like the report in a document or a simple email.",
    "Rolling hills stretched for miles, dotted with sheep and the occasional stone wall.",
    "Good morning! It's a fresh start, and your first meeting isn't until ten thirty.",
    "I can summarize that long article into a few clear sentences if that helps you.",
    "Nine bright balloons drifted up and away, growing smaller against the blue sky.",
    "The bakery on the corner sells warm cinnamon rolls every Saturday morning.",
    "Take a slow, deep breath in through your nose, and let it out gently through your mouth.",
    "We can reschedule the call to next week if today turns out to be too busy.",
    "Thunder rumbled in the distance as the first heavy raindrops hit the window.",
    "I've turned on do not disturb so you can finish your work without interruptions.",
    "The marathon route winds through the city, past the river, and up the long hill.",
    "Believe it or not, a single honeybee may visit hundreds of flowers in one day.",
    "Your code finished running successfully, and all of the tests passed on the first try.",
    "Let's celebrate the little wins; they add up to something big over time.",
    "The violinist tuned her strings carefully before the concert hall fell silent.",
    "I can set this to repeat every weekday, or just once, whichever you prefer.",
    "Tall ships sailed into the harbor as the morning mist began to slowly lift.",
    "Would you like a savory breakfast today, or something sweet like pancakes?",
    "The teacher praised the students for their patience, effort, and clever thinking.",
    "I've found a quiet cafe two blocks away with strong coffee and plenty of seats.",
    "Snowflakes drifted down softly, covering the rooftops in a smooth white blanket.",
    "Let me walk you through it step by step so nothing feels confusing or rushed.",
    "The river sparkled in the sunlight as kayaks glided gently along the current.",
    "Your password was updated successfully, and a confirmation was sent to your inbox.",
    "Ten tiny ducklings followed their mother in a neat line across the busy road.",
    "I think the best plan is to start early, stay steady, and finish before lunch.",
    "The orchestra swelled to a powerful finish, and the audience rose to applaud.",
    "Don't worry, I backed up your files last night, so everything is safe and sound.",
    "A warm cup of tea, a good book, and a quiet afternoon sound just about perfect.",
    "The hikers reached the summit at noon and paused to admire the sweeping view.",
    "I'll text you the moment your order ships so you can track it along the way.",
    "Every great journey begins with a single, slightly nervous step out the door.",
    "The bridge lights shimmered on the water as the city settled into a calm evening.",
    "Could you grab your umbrella? There's a sixty percent chance of rain this afternoon.",
    "She practiced the speech three times until the words felt natural and easy.",
    "I can play relaxing rain sounds, ocean waves, or quiet piano while you focus.",
    "The farmers market had ripe peaches, sweet corn, and jars of golden local honey.",
    "Let's keep things simple today and tackle just the three most important tasks.",
    "A red kite soared high above the cliffs, riding the steady afternoon wind.",
    "Your meeting notes are saved, organized by date, and ready whenever you need them.",
    "The campfire crackled softly while we told stories beneath a sky full of stars.",
    "I understand this is frustrating, and I'm here to help you sort it out calmly.",
    "Fresh basil, ripe tomatoes, and a little garlic make a wonderfully simple sauce.",
    "We arrived just as the doors opened, so we had our pick of the very best seats.",
    "The clock tower chimed twelve times, echoing across the empty cobblestone square.",
    "I'll remember that you prefer your coffee with oat milk and just a little sugar.",
    "Bright autumn leaves crunched underfoot as we walked the long trail through the woods.",
    "Let me confirm the details: dinner for four at eight, under the name Carter.",
    "The scientist recorded each result carefully in a worn, leather bound notebook.",
    "You did really well today, and it's completely okay to rest and recharge now.",
    "A pair of robins built a small, tidy nest in the corner of the front porch.",
    "I can break this into a checklist so you can tick off each piece as you go.",
    "The ferry crossed the wide channel slowly, leaving a long ribbon of white foam.",
    "Tomorrow's forecast shows clear skies in the morning and a few clouds by evening.",
    "We laughed so hard at the joke that we almost missed the next part of the show.",
    "Your savings goal is now eighty percent funded; you're closer than you think.",
    "The painter mixed a soft orange and a pale pink to capture the early sunrise.",
    "Let's pause here, review what we've done, and decide what comes next together.",
    "Five fast runners sprinted down the track as the crowd cheered them to the line.",
    "I've dimmed the screen and switched to night mode to make reading easier on your eyes.",
    "The little shop smelled of cinnamon, old books, and freshly brewed black coffee.",
    "Whenever you're ready, just say the word, and we'll get started right away.",
    "A thin crescent moon hung low over the hills as the last bird sang its evening song.",
    "Good evening. I've gone ahead and dimmed the lights, locked the front door, and set the morning alarm for six forty five, so you can relax now and just unwind.",
    "Here's a quick recap of your day: two meetings in the morning, lunch with Daniel at noon, and a dentist appointment at three thirty in the afternoon downtown.",
    "If you'd like, I can read the article to you while you make breakfast, then summarize the key points into a short list you can glance at before your first call.",
    "The forecast is calling for scattered showers through the early afternoon, clearing up by around four, so you might want to bring a light jacket and a small umbrella.",
    "I went through your inbox and flagged the three emails that actually need a reply today, and I archived the rest of the newsletters so they stay out of your way.",
    "Let's take this one step at a time. First we'll outline the main idea, then we'll fill in the details, and finally we'll polish the wording until it reads smoothly.",
    "When the timer goes off, stand up, stretch your arms over your head, take a few slow breaths, and look out the window for a minute before sitting back down to work.",
    "The recipe is simple and forgiving: warm the olive oil, add the garlic until it's fragrant, stir in the tomatoes, and let everything simmer gently for twenty minutes.",
    "Your package shipped this morning and should arrive by Thursday. I'll send you a tracking link, and I can notify you the moment it's out for delivery on your street.",
    "I really enjoy helping you stay organized, and honestly, watching your little projects come together piece by piece is one of my favorite parts of the whole day.",
    "Before the big presentation, remember to breathe, slow down your pace, and make eye contact with the room. You know this material better than anyone else in there.",
    "We can plan the trip together. I'll compare flights, find a hotel near the conference center, and put together a simple itinerary so nothing feels rushed or stressful.",
    "The garden is doing wonderfully this spring. The tomatoes are climbing the trellis, the basil is thick and green, and the first strawberries are just starting to ripen.",
    "I noticed you've been working pretty late all week, so I blocked out tomorrow evening as personal time. No reminders, no alerts, just a quiet space to rest and recharge.",
    "Let me know how you'd like your coffee this morning, and whether you want the news headlines, a calm playlist, or simply a few minutes of peaceful quiet to start the day.",
    "The hiking trail climbs gently through the pines for about two miles, then opens onto a wide ridge where you can see the whole valley spread out far below you.",
    "I've saved all of your notes from the meeting, organized them by topic, and highlighted the three action items that have deadlines coming up later this week.",
    "Whenever you feel overwhelmed, just tell me, and we'll set everything else aside, pick the single most important task, and focus only on that until it's finished.",
    "The bakery downtown just put out a fresh batch of sourdough, and the line is already forming, so if you want a loaf, this would be a good time to head over there.",
    "Thank you for being so patient with me while I learn. Every conversation teaches me a little more about how to be genuinely helpful, and I really do appreciate that.",
    "The concert starts at eight, the doors open at seven, and parking fills up fast, so I'd suggest leaving the house by six thirty to give yourself plenty of time.",
    "I rewrote that paragraph to make it clearer and a touch warmer. Take a look, and if you'd like a different tone, just say the word and I'll happily adjust it again.",
    "On clear nights like this, you can step outside, let your eyes adjust for a few minutes, and watch dozens of stars slowly appear across the deep, quiet sky.",
    "Your savings are growing steadily. At this pace you'll reach your goal a couple of months early, which means a little extra cushion for whatever comes up along the way.",
    "Let's make tomorrow a good one. I'll wake you gently with soft music, have the weather and your schedule ready, and start the coffee maker right as your alarm goes off.",
    "The little bookshop on the corner has comfortable chairs, warm lighting, and shelves that go all the way to the ceiling, packed with stories waiting to be discovered.",
    "I can absolutely handle that for you. Give me the details, take a break, and by the time you're back I'll have a clean draft ready for you to review and approve.",
    "The river was calm and glassy this morning, mirroring the orange clouds so perfectly that for a moment it was hard to tell where the water ended and the sky began.",
    "We've covered a lot of ground today, and you should feel proud. You showed up, you stayed focused, and you finished the hard part. The rest will come much easier now.",
    "If the traffic stays light, you'll make it to the airport with time to spare, grab a coffee at the gate, and still have a few quiet minutes before they start boarding.",
    "I'll keep the house at a comfortable temperature, water the plants on schedule, and send you a short update each evening so you never have to wonder how things are going.",
    "The teacher reminded the class to read slowly, picture each scene, and pause whenever a sentence felt important, because good stories reward a little patience and care.",
    "Let's celebrate that win, even if it feels small. Progress is progress, and the steady habits you're building today are exactly what will carry you through the bigger goals.",
    "I've found a cozy little cabin by the lake for the weekend. It has a fireplace, a small dock, and a wide porch that looks straight out over the water toward the hills.",
    "Take your time answering. There's no rush at all. When you're ready, just tell me what you're thinking, and we'll figure out the next step together, calmly and clearly.",
    "The morning fog is lifting off the fields now, the birds are getting louder, and a thin line of gold is spreading along the horizon as the sun finally begins to rise.",
    "I double checked the numbers twice, and everything balances perfectly. Your report is accurate, the totals match, and it's ready to send whenever you give me the go ahead.",
    "Let's wind down for the night. I'll lower the lights, queue up some gentle rain sounds, and set a soft reminder so you actually put the phone down and get some real rest.",
    "The market this morning was full of color and noise, with crates of ripe peaches, buckets of cut flowers, and the warm, sweet smell of fresh bread drifting through the air.",
    "You handled that difficult conversation with a lot of grace. It isn't easy to stay calm under pressure, and the way you listened carefully really made a genuine difference.",
    "I'll set three gentle reminders through the afternoon so you remember to drink some water, rest your eyes for a minute, and stand up to stretch before your next long meeting.",
    "The waves rolled in slow and steady, the kind of rhythm that makes your shoulders drop and your thoughts go quiet, until all you notice is the sound and the cool sea air.",
    "Here's the plan for the launch: we'll finalize the copy today, schedule the announcement for Tuesday morning, and keep a close eye on the feedback as it starts to come in.",
    "Whenever you're learning something new, it's completely normal to feel a little lost at first. Stick with it, ask questions, and one day it will simply start to make sense.",
    "The old clock on the mantel still keeps perfect time, ticking away quietly in the corner, marking each hour with a soft chime that the whole family has known for years.",
    "I can translate that message, adjust the tone to sound more friendly, and have it ready to send in under a minute, so you can reply quickly without losing your warmth.",
    "Snow fell softly all through the night, and by morning the whole street was hushed and white, with rooftops, fences, and parked cars wearing smooth, rounded caps of powder.",
    "Let's keep it simple and kind to yourself today. Pick three things that truly matter, do them well, and let the rest wait. You don't have to carry everything all at once.",
    "The train glided out of the station right on time, picking up speed past the warehouses and the river, until the city blurred into green fields rushing by the window.",
    "I'm proud of how far you've come. A few weeks ago this felt impossible, and now you're moving through it with confidence. That kind of steady growth is genuinely impressive.",
    "The candle flickered on the table while the rain tapped against the glass, and for a little while the whole evening felt soft and slow and perfectly, wonderfully ordinary.",
    "I'll prepare everything for the morning: your schedule, the weather, a short news summary, and a reminder about the call at ten, all ready for you the moment you wake up.",
    "She tightened her laces, took a slow breath at the starting line, and when the whistle finally blew, she pushed off hard and settled quickly into a strong, even rhythm.",
    "Let's review what worked and what didn't, without being too hard on ourselves. Every attempt teaches us something useful, and the next version will be better because of it.",
    "The lighthouse swept its beam across the dark water again and again, a patient, steady signal telling every distant ship that the shore was near and the harbor was waiting.",
]

def synth(text):
    url = ("https://api.elevenlabs.io/v1/text-to-speech/" + VOICE_ID +
           "/stream?output_format=" + OUT_FMT)
    body = json.dumps({
        "text": text, "model_id": MODEL,
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75,
                           "style": 0.0, "use_speaker_boost": True},
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "xi-api-key": API_KEY, "Content-Type": "application/json", "Accept": "audio/pcm"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()

rows, total_bytes, made = [], 0, 0
for i, s in enumerate(SENTENCES):
    wid = "vella_%04d" % i
    wp = os.path.join(WAVS, wid + ".wav")
    if os.path.exists(wp) and os.path.getsize(wp) > 4096:
        rows.append((wid, s)); total_bytes += os.path.getsize(wp); continue
    try:
        pcm = synth(s)
    except urllib.error.HTTPError as e:
        msg = ""
        try: msg = e.read().decode("utf-8", "ignore")[:200]
        except Exception: pass
        print("HTTP %s on #%d: %s" % (e.code, i, msg))
        if e.code in (401, 403):
            print("Auth/plan problem - stopping."); break
        time.sleep(2); continue
    except Exception as e:
        print("ERR #%d: %s" % (i, e)); time.sleep(2); continue
    if len(pcm) < SR:  # under ~0.5s, likely failed
        print("SHORT #%d (%d bytes), skipping" % (i, len(pcm))); continue
    with wave.open(wp, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm)
    rows.append((wid, s)); total_bytes += len(pcm); made += 1
    if made % 10 == 0:
        print("generated %d / %d  (~%.1f min so far)" % (len(rows), len(SENTENCES), (total_bytes/2/SR)/60))
    time.sleep(0.15)

with open(os.path.join(OUTDIR, "metadata.csv"), "w", encoding="utf-8", newline="") as f:
    for wid, s in rows:
        f.write(wid + "|" + s + "\n")

print("CORPUS DONE: clips=%d  audio=%.1f min  newly_made=%d" % (
    len(rows), (total_bytes/2/SR)/60, made))
print("dataset at:", OUTDIR)
