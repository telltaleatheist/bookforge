#!/bin/bash

# Manual Audiobook Assembly Script
# Use this when ebook2audiobook assembly fails but FLAC files were created successfully

if [ $# -lt 3 ]; then
    echo "Usage: $0 <session-id> <title> <author>"
    echo "Example: $0 2ab3fe74-a055-4e50-8d34-c8c8a03e9a91 \"How Democracies Die\" \"Steven Levitsky, Daniel Ziblatt\""
    exit 1
fi

SESSION_ID="$1"
TITLE="$2"
AUTHOR="$3"
OUTPUT_NAME=$(echo "$TITLE" | sed 's/[^a-zA-Z0-9 ]//g' | sed 's/ /_/g')

SESSION_DIR="/Users/telltale/Projects/ebook2audiobook/tmp/ebook-$SESSION_ID"

# Find the actual working directory
WORK_DIR=$(find "$SESSION_DIR" -maxdepth 1 -type d ! -path "$SESSION_DIR" | head -1)

if [ -z "$WORK_DIR" ]; then
    echo "Error: Could not find working directory in $SESSION_DIR"
    exit 1
fi

echo "Found working directory: $WORK_DIR"

# Check for FLAC files
FLAC_COUNT=$(ls "$WORK_DIR"/chapters/sentences/*.flac 2>/dev/null | wc -l | tr -d ' ')

if [ "$FLAC_COUNT" -eq 0 ]; then
    echo "Error: No FLAC files found in $WORK_DIR/chapters/sentences/"
    exit 1
fi

echo "Found $FLAC_COUNT FLAC files"

# Create file list
cd "$WORK_DIR" || exit 1
ls chapters/sentences/*.flac | sort -V | sed "s/^/file '/" | sed "s/$/'/" > filelist.txt

echo "Created file list with $(wc -l < filelist.txt) entries"

# Output path
OUTPUT_PATH="/Volumes/Callisto/books/audiobooks/${OUTPUT_NAME}.m4b"

echo "Starting assembly..."
echo "Title: $TITLE"
echo "Author: $AUTHOR"
echo "Output: $OUTPUT_PATH"

# Create chapter metadata (basic - evenly distributed)
echo "Creating chapter metadata..."
TOTAL_DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 -f concat -safe 0 -i filelist.txt)
NUM_CHAPTERS=10  # Default to 10 chapters, adjust as needed

cat > /tmp/chapters_metadata.txt <<EOF
;FFMETADATA1
title=$TITLE
artist=$AUTHOR
album=$TITLE
genre=Audiobook

EOF

# Add evenly distributed chapters
CHAPTER_DURATION=$(echo "$TOTAL_DURATION * 1000 / $NUM_CHAPTERS" | bc)
for i in $(seq 1 $NUM_CHAPTERS); do
    START=$(echo "($i - 1) * $CHAPTER_DURATION" | bc)
    END=$(echo "$i * $CHAPTER_DURATION" | bc)
    if [ $i -eq $NUM_CHAPTERS ]; then
        END=$(echo "$TOTAL_DURATION * 1000" | bc)
    fi
    cat >> /tmp/chapters_metadata.txt <<EOF
[CHAPTER]
TIMEBASE=1/1000
START=${START%.*}
END=${END%.*}
title=Chapter $i

EOF
done

# Run ffmpeg assembly with chapters
ffmpeg -f concat -safe 0 -i filelist.txt \
    -i /tmp/chapters_metadata.txt \
    -map 0:a -map_metadata 1 \
    -c:a aac -b:a 128k \
    -movflags +faststart \
    "$OUTPUT_PATH" -y

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Assembly complete!"

    # Look for cover image in the audiobook folder
    # Try to match based on title similarity
    AUDIOBOOK_FOLDER="/Users/telltale/Documents/BookForge/audiobooks"
    COVER_PATH=""
    TITLE_SEARCH=$(echo "$TITLE" | sed 's/[^a-zA-Z0-9 ]//g' | sed 's/ /_/g')

    # First, look for folder with matching title pattern
    for folder in "$AUDIOBOOK_FOLDER"/*; do
        if [ -d "$folder" ]; then
            FOLDER_NAME=$(basename "$folder")
            # Check if folder name contains the title (ignoring punctuation)
            if echo "$FOLDER_NAME" | grep -qi "${TITLE_SEARCH:0:20}"; then
                # Found likely matching folder, look for cover
                if [ -f "$folder/cover.png" ]; then
                    COVER_PATH="$folder/cover.png"
                    break
                elif [ -f "$folder/cover.jpg" ]; then
                    COVER_PATH="$folder/cover.jpg"
                    break
                elif [ -f "$folder/cover.jpeg" ]; then
                    COVER_PATH="$folder/cover.jpeg"
                    break
                fi
            fi
        fi
    done

    # If no cover found yet, check the session directory itself
    if [ -z "$COVER_PATH" ]; then
        if [ -f "$WORK_DIR/cover.png" ]; then
            COVER_PATH="$WORK_DIR/cover.png"
        elif [ -f "$WORK_DIR/cover.jpg" ]; then
            COVER_PATH="$WORK_DIR/cover.jpg"
        elif [ -f "$WORK_DIR/cover.jpeg" ]; then
            COVER_PATH="$WORK_DIR/cover.jpeg"
        fi
    fi

    # Add cover if found
    if [ -n "$COVER_PATH" ] && [ -f "$COVER_PATH" ]; then
        echo "Adding cover image from: $COVER_PATH"
        /opt/homebrew/bin/m4b-tool meta "$OUTPUT_PATH" --cover "$COVER_PATH"
        echo "✅ Cover image added!"
    else
        echo "⚠️  No cover image found"
    fi

    echo "Audiobook saved to: $OUTPUT_PATH"
    echo "Size: $(ls -lh "$OUTPUT_PATH" | awk '{print $5}')"
else
    echo ""
    echo "❌ Assembly failed!"
    exit 1
fi