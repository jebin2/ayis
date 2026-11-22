package watchdog

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io/fs"
	"path"
	"reflect"
	"sort"
)

// What the cloud watchdog is made of. Everything here is what the deployed
// function is compared against: a function that is not exactly this is "not
// current", and `ayis watchdog check` says which piece drifted.
const (
	RuntimeName = "python3.13"
	Handler     = PackageDir + ".handler.handler"
	PolicyName  = "idle-guard"
	EveryMin    = 5 // how often the schedule runs it; the rule and the app read this one number
	TimeoutSec  = 300
	MemoryMB    = 128
	BootGrace   = 20
)

// StateRule is EC2's own events: state changes, so the watchdog can confirm a
// box is gone, and spot interruption warnings. One rule for both - a detail
// filter would have to exclude the warning - and the function ignores every
// state that is not an end.
func StateRule(host string) string { return Name(host) + "-state" }

// Settings are the figures the function is configured with.
type Settings struct {
	Host         string
	Account      string
	Bucket       string // the archive bucket, as ayis names it
	IdleMinutes  int
	StuckMinutes int
	ExpiryDays   int
	NtfyURL      string // "" leaves it absent
	// The hard limits, each 0 or "" for off: the month's machine hours, one
	// session's hours, and the deny policy a spent AWS budget attaches.
	MaxHoursMonth   int
	MaxSessionHours int
	BlockPolicyARN  string
	S3GBMonth       string // the price as ayis has it ("0.025"); "" when unknown
	INRPerUSD       string // "" when unknown
	ODUSDHour       string // an on-demand hour of the machine type; "" when unknown
}

// Env is the function's environment, in the form `aws lambda` takes it, and
// the form the fingerprint is made of: the exact text matters, because it was
// hashed into the description of every watchdog already deployed.
func (s Settings) Env() string {
	opt := func(k, v string) string {
		if v == "" {
			return ""
		}
		return "," + k + "=" + v
	}
	num := func(k string, v int) string {
		if v == 0 {
			return ""
		}
		return opt(k, fmt.Sprint(v))
	}
	// The limits come last, and only when on: a watchdog deployed without them
	// keeps the exact text - and so the fingerprint - it was deployed with.
	return fmt.Sprintf("Variables={AYIS_TS_HOST=%s,AYIS_IDLE_MINUTES=%d,AYIS_BOOT_GRACE_MINUTES=%d,AYIS_STUCK_MINUTES=%d,AYIS_BUCKET=%s,AYIS_ACCOUNT=%s,AYIS_ARCHIVE_EXPIRY_DAYS=%d%s%s%s%s%s%s%s}",
		s.Host, s.IdleMinutes, BootGrace, s.StuckMinutes, s.Bucket, s.Account, s.ExpiryDays,
		opt("AYIS_S3_USD_GB_MONTH", s.S3GBMonth), opt("AYIS_INR_PER_USD", s.INRPerUSD), opt("AYIS_NTFY_URL", s.NtfyURL),
		num("AYIS_MAX_HOURS_MONTH", s.MaxHoursMonth), num("AYIS_MAX_SESSION_HOURS", s.MaxSessionHours), opt("AYIS_BLOCK_POLICY_ARN", s.BlockPolicyARN), opt("AYIS_OD_USD_HOUR", s.ODUSDHour))
}

// EnvMap is the same environment as a map, for the API: the text form above is
// what the fingerprint hashes, this is what Lambda is given.
func (s Settings) EnvMap() map[string]string {
	m := map[string]string{
		"AYIS_TS_HOST": s.Host, "AYIS_IDLE_MINUTES": fmt.Sprint(s.IdleMinutes), "AYIS_BOOT_GRACE_MINUTES": fmt.Sprint(BootGrace),
		"AYIS_STUCK_MINUTES": fmt.Sprint(s.StuckMinutes), "AYIS_BUCKET": s.Bucket, "AYIS_ACCOUNT": s.Account,
		"AYIS_ARCHIVE_EXPIRY_DAYS": fmt.Sprint(s.ExpiryDays),
	}
	if s.S3GBMonth != "" {
		m["AYIS_S3_USD_GB_MONTH"] = s.S3GBMonth
	}
	if s.INRPerUSD != "" {
		m["AYIS_INR_PER_USD"] = s.INRPerUSD
	}
	if s.NtfyURL != "" {
		m["AYIS_NTFY_URL"] = s.NtfyURL
	}
	if s.MaxHoursMonth != 0 {
		m["AYIS_MAX_HOURS_MONTH"] = fmt.Sprint(s.MaxHoursMonth)
	}
	if s.MaxSessionHours != 0 {
		m["AYIS_MAX_SESSION_HOURS"] = fmt.Sprint(s.MaxSessionHours)
	}
	if s.ODUSDHour != "" {
		m["AYIS_OD_USD_HOUR"] = s.ODUSDHour
	}
	if s.BlockPolicyARN != "" {
		m["AYIS_BLOCK_POLICY_ARN"] = s.BlockPolicyARN
	}
	return m
}

// Fingerprint is everything about the function that is not its code, as one
// short hash kept in its description - so drift in any of it reads as "not
// current".
func (s Settings) Fingerprint(roleARN string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%s|%d|%d|%s\n", RuntimeName, Handler, roleARN, TimeoutSec, MemoryMB, s.Env())))
	return hex.EncodeToString(sum[:])[:12]
}

// Policy is the role's policy. The watchdog may describe and read metrics
// anywhere; stop, terminate and tag ONLY the instance tagged with this host
// name, and tag it only with the keys it uses; write only its own log group. It
// cannot launch anything, read the game archive beyond expiring it, or touch
// IAM. Archive expiry adds CloudTrail lookups, its own free SSM marks, and
// list/read/delete on ayis's archive buckets - and only while expiry is on. With
// expiry 0 the role cannot delete a single game.
//
// The SSM resource's region is a wildcard, deliberately: an IAM role is GLOBAL,
// so a policy pinned to one region was revoked by the watchdog installed last
// in another. What scopes it is the account and the parameter path.
func (s Settings) Policy(region string) map[string]any {
	stmts := []any{
		map[string]any{"Sid": "Look", "Effect": "Allow", "Action": []string{"ec2:DescribeInstances", "ec2:DescribeVolumes", "cloudwatch:GetMetricStatistics"}, "Resource": "*"},
		map[string]any{"Sid": "EndOnlyTheTaggedBox", "Effect": "Allow", "Action": []string{"ec2:StopInstances", "ec2:TerminateInstances"},
			"Resource":  fmt.Sprintf("arn:aws:ec2:%s:%s:instance/*", region, s.Account),
			"Condition": map[string]any{"StringEquals": map[string]any{"ec2:ResourceTag/Name": s.Host}}},
		map[string]any{"Sid": "MarkWhenFirstSeenGoingDown", "Effect": "Allow", "Action": "ec2:CreateTags",
			"Resource": fmt.Sprintf("arn:aws:ec2:%s:%s:instance/*", region, s.Account),
			"Condition": map[string]any{
				"StringEquals": map[string]any{"ec2:ResourceTag/Name": s.Host},
				"ForAllValues:StringEquals": map[string]any{"aws:TagKeys": []string{
					"ayis-going-down-since", "ayis-slow-noted", "ayis-forced", "ayis-stopped-since", "ayis-stopped-warned", "ayis-session-warned"}}}},
		// After the machine stops ITSELF (idle) with its games saved, its games disk
		// goes too: detach and delete, only for the volume and instance tagged as
		// this host's - never any other disk in the account.
		map[string]any{"Sid": "DropTheGamesDiskAfterAnIdleStop", "Effect": "Allow", "Action": []string{"ec2:DetachVolume", "ec2:DeleteVolume"},
			"Resource":  []string{fmt.Sprintf("arn:aws:ec2:%s:%s:volume/*", region, s.Account), fmt.Sprintf("arn:aws:ec2:%s:%s:instance/*", region, s.Account)},
			"Condition": map[string]any{"StringEquals": map[string]any{"ec2:ResourceTag/Name": s.Host}}},
		map[string]any{"Sid": "OwnLogs", "Effect": "Allow", "Action": []string{"logs:CreateLogStream", "logs:PutLogEvents"},
			"Resource": fmt.Sprintf("arn:aws:logs:%s:%s:log-group:%s:*", region, s.Account, LogGroup(s.Host))},
	}
	// The one object it reads to know the games are saved: ayis-library's marker.
	if s.Bucket != "" {
		stmts = append(stmts, map[string]any{"Sid": "ReadTheSavedMarker", "Effect": "Allow", "Action": "s3:GetObject",
			"Resource": fmt.Sprintf("arn:aws:s3:::%s/*pushed.json", s.Bucket)})
	}
	// The month's hours are kept in its own free SSM marks, under the same path.
	if s.MaxHoursMonth > 0 && s.ExpiryDays <= 0 {
		stmts = append(stmts, map[string]any{"Sid": "UsageMarks", "Effect": "Allow",
			"Action":   []string{"ssm:GetParameter", "ssm:PutParameter"},
			"Resource": fmt.Sprintf("arn:aws:ssm:*:%s:parameter/ayis/%s/*", s.Account, s.Host)})
	}
	// Whether the budget is spent: is its deny policy attached to anyone. Read only,
	// and only that one policy.
	if s.BlockPolicyARN != "" {
		stmts = append(stmts, map[string]any{"Sid": "IsTheBudgetSpent", "Effect": "Allow",
			"Action": "iam:ListEntitiesForPolicy", "Resource": s.BlockPolicyARN})
	}
	// What a hard limit's notification says it cost: the spot price now, and the
	// month's spend from ayis's own budget. Both read only, and both free.
	if s.MaxHoursMonth > 0 || s.MaxSessionHours > 0 || s.BlockPolicyARN != "" {
		stmts = append(stmts,
			map[string]any{"Sid": "WhatAnHourCosts", "Effect": "Allow", "Action": "ec2:DescribeSpotPriceHistory", "Resource": "*"},
			map[string]any{"Sid": "WhatTheMonthCost", "Effect": "Allow", "Action": "budgets:ViewBudget",
				"Resource": fmt.Sprintf("arn:aws:budgets::%s:budget/%s-monthly", s.Account, s.Host)})
	}
	if s.ExpiryDays > 0 {
		stmts = append(stmts,
			map[string]any{"Sid": "ArchiveExpiryLookups", "Effect": "Allow", "Action": "cloudtrail:LookupEvents", "Resource": "*"},
			map[string]any{"Sid": "ArchiveExpiryFindBuckets", "Effect": "Allow", "Action": "s3:ListAllMyBuckets", "Resource": "*"},
			map[string]any{"Sid": "ArchiveExpiryBucket", "Effect": "Allow",
				"Action":   []string{"s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:DeleteBucket", "s3:GetBucketLocation"},
				"Resource": "arn:aws:s3:::ayis-library-*"},
			map[string]any{"Sid": "ArchiveExpiryObjects", "Effect": "Allow",
				"Action":   []string{"s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"},
				"Resource": "arn:aws:s3:::ayis-library-*/*"},
			map[string]any{"Sid": "ArchiveExpiryMarks", "Effect": "Allow",
				"Action":   []string{"ssm:GetParameter", "ssm:PutParameter", "ssm:GetParametersByPath", "ssm:DeleteParameter"},
				"Resource": fmt.Sprintf("arn:aws:ssm:*:%s:parameter/ayis/%s/*", s.Account, s.Host)})
	}
	return map[string]any{"Version": "2012-10-17", "Statement": stmts}
}

// PolicyMatches reports whether the deployed policy document is this one.
// Both are compared as data, not as text: IAM hands the document back
// reformatted.
func PolicyMatches(deployed []byte, want map[string]any) bool {
	var got any
	if json.Unmarshal(deployed, &got) != nil {
		return false
	}
	wb, _ := json.Marshal(want)
	var w any
	_ = json.Unmarshal(wb, &w)
	return reflect.DeepEqual(got, w)
}

// File is one file of the deployment package, by its path inside the zip.
type File struct {
	Name string
	Data []byte
}

// PackageDir is the Python package the function is, and the folder it ships in.
const PackageDir = "ayis_watchdog"

// Package reads the function's source: every .py file of dir in fsys, named
// ayis_watchdog/<file> and in name order, so the same source is always the same
// zip. Anything else in the folder (a __pycache__, the tests beside it) is not
// shipped.
func Package(fsys fs.FS, dir string) ([]File, error) {
	names, err := fs.Glob(fsys, path.Join(dir, "*.py"))
	if err != nil {
		return nil, err
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("no watchdog source in %s", dir)
	}
	sort.Strings(names)
	files := make([]File, 0, len(names))
	for _, n := range names {
		b, err := fs.ReadFile(fsys, n)
		if err != nil {
			return nil, err
		}
		files = append(files, File{Name: PackageDir + "/" + path.Base(n), Data: b})
	}
	return files, nil
}

// Zip is the deployment package, byte-identical on every run: a fixed
// timestamp, each file stored rather than deflated (zlib versions compress
// differently), mode 0644, in the order given. That is what lets "is the
// deployed code current" be one comparison against Lambda's CodeSha256. It
// returns the zip and the base64 SHA-256 Lambda reports.
func Zip(files []File) (zip []byte, codeSHA256 string) {
	const dosTime, dosDate = 0, 0x21 // 1980-01-01 00:00:00
	le := binary.LittleEndian
	var b, central bytes.Buffer
	w := func(buf *bytes.Buffer, v any) { _ = binary.Write(buf, le, v) }

	for _, f := range files {
		crc := crc32.ChecksumIEEE(f.Data)
		size := uint32(len(f.Data))
		offset := uint32(b.Len())

		// Local file header.
		w(&b, uint32(0x04034b50))
		w(&b, uint16(20)) // version needed
		w(&b, uint16(0))  // flags
		w(&b, uint16(0))  // stored
		w(&b, uint16(dosTime))
		w(&b, uint16(dosDate))
		w(&b, crc)
		w(&b, size)
		w(&b, size)
		w(&b, uint16(len(f.Name)))
		w(&b, uint16(0))
		b.WriteString(f.Name)
		b.Write(f.Data)

		// Its central directory entry, written after every file.
		w(&central, uint32(0x02014b50))
		w(&central, uint16(3<<8|20)) // made by: unix, 2.0
		w(&central, uint16(20))
		w(&central, uint16(0))
		w(&central, uint16(0))
		w(&central, uint16(dosTime))
		w(&central, uint16(dosDate))
		w(&central, crc)
		w(&central, size)
		w(&central, size)
		w(&central, uint16(len(f.Name)))
		w(&central, uint16(0)) // extra
		w(&central, uint16(0)) // comment
		w(&central, uint16(0)) // disk
		w(&central, uint16(0)) // internal attributes
		w(&central, uint32(0o644<<16))
		w(&central, offset)
		central.WriteString(f.Name)
	}
	centralAt := uint32(b.Len())
	centralSize := uint32(central.Len())
	b.Write(central.Bytes())

	// End of central directory.
	w(&b, uint32(0x06054b50))
	w(&b, uint16(0))
	w(&b, uint16(0))
	w(&b, uint16(len(files)))
	w(&b, uint16(len(files)))
	w(&b, centralSize)
	w(&b, centralAt)
	w(&b, uint16(0))

	sum := sha256.Sum256(b.Bytes())
	return b.Bytes(), base64.StdEncoding.EncodeToString(sum[:])
}

func sha256b64(b []byte) string {
	sum := sha256.Sum256(b)
	return base64.StdEncoding.EncodeToString(sum[:])
}
