CREATE TABLE `tj_exposure_snapshots` (
	`snap_date` date NOT NULL,
	`exposure` decimal(12,2) NOT NULL,
	CONSTRAINT `tj_exposure_snapshots_snap_date` PRIMARY KEY(`snap_date`)
);
