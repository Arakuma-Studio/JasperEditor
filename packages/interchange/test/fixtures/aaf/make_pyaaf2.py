# Writes a small Edit Protocol AAF with pyaaf2 (a third-party writer) for the "foreign dialect" import test:
# a composition with a picture slot (two clips with a dissolve) and a sound slot, linked media by NetworkLocator.
# Run by test/aaf.test.ts when /tmp/interchange-venv exists; the output is never committed.
import sys
import aaf2

out = sys.argv[1]
with aaf2.open(out, 'w') as f:
    rate = 25
    mobs = []
    for i, name in enumerate(['shot_a.mov', 'shot_b.mov']):
        master = f.create.MasterMob(name)
        f.content.mobs.append(master)
        # file source mob with a CDCI descriptor and a locator
        src = f.create.SourceMob()
        desc = f.create.CDCIDescriptor()
        desc['StoredWidth'].value = 1920
        desc['StoredHeight'].value = 1080
        desc['FrameLayout'].value = 'FullFrame'
        desc['ImageAspectRatio'].value = '16/9'
        desc['VideoLineMap'].value = [42, 0]
        desc['ComponentWidth'].value = 8
        desc['HorizontalSubsampling'].value = 2
        desc['SampleRate'].value = rate
        desc['Length'].value = 1000
        loc = f.create.NetworkLocator()
        loc['URLString'].value = 'file:///shots/' + name
        desc['Locator'].append(loc)
        src.descriptor = desc
        f.content.mobs.append(src)
        slot = src.create_empty_sequence_slot(rate, media_kind='picture')
        slot.segment.components.append(f.create.SourceClip(media_kind='picture', length=1000))
        mslot = master.create_timeline_slot(rate)
        mclip = f.create.SourceClip(media_kind='picture', length=1000)
        mclip['SourceID'].value = src.mob_id
        mclip['SourceMobSlotID'].value = slot.slot_id
        mclip['StartTime'].value = 0
        mslot.segment = mclip
        mobs.append((master, mslot))
    comp = f.create.CompositionMob('Foreign Edit')
    f.content.mobs.append(comp)
    pic = comp.create_timeline_slot(rate)
    seq = f.create.Sequence(media_kind='picture')
    pic.segment = seq
    a = mobs[0][0].create_source_clip(mobs[0][1].slot_id, start=10, length=50)
    seq.components.append(a)
    tr = f.create.Transition(media_kind='picture', length=10)
    tr['CutPoint'].value = 5
    opdef = f.create.OperationDef(aaf2.auid.AUID('0c3bea41-fc05-11d2-8a09-00600814 3e6f'.replace(' ', '')), 'VideoDissolve_2', '')
    opdef.media_kind = 'picture'
    opdef['NumberInputs'].value = 2
    f.dictionary.register_def(opdef)
    og = f.create.OperationGroup(opdef, length=10)
    og.media_kind = 'picture'
    tr['OperationGroup'].value = og
    seq.components.append(tr)
    b = mobs[1][0].create_source_clip(mobs[1][1].slot_id, start=100, length=60)
    seq.components.append(b)
    filler = f.create.Filler(media_kind='picture', length=25)
    seq.components.append(filler)

    snd = comp.create_sound_slot(edit_rate=48000)
    sseq = f.create.Sequence(media_kind='sound')
    snd.segment = sseq
    sseq.components.append(f.create.Filler(media_kind='sound', length=48000))
